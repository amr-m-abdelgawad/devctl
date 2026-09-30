import { Detector } from "../secrets/detector.ts";
import { loadPluginPaths } from "../plugins/registry.ts";
import { RECORD_BATCH_BYTES, RECORD_BATCH_MS, RECORD_BATCH_RECORDS } from "../../domain/logs/budgets.ts";
import { approxRecordBytes } from "../../domain/logs/size.ts";
import { defaultLogParser, LogManager, type LogRecord } from "./logs.ts";
import type { WorkerRequest, WorkerResponse } from "./log-worker-protocol.ts";
import { ChunkHoldQueue } from "./chunk-hold.ts";

let manager: LogManager | undefined;
let detector: Detector | undefined;
let chain = Promise.resolve();

type ChunkMessage = Extract<WorkerRequest, { type: "chunk" }>;

const HELD_RETRY_MS = 5;
let hold: ChunkHoldQueue<ChunkMessage> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

// Committed records go back in batches: at most one per RECORD_BATCH_MS, and
// sooner only when a batch fills. A quiet stream's line leaves at once.
let outbox: LogRecord[] = [];
let outboxBytes = 0;
let outboxTimer: ReturnType<typeof setTimeout> | undefined;
let outboxSentAt = 0;
// The newest structured append taken and not yet acked.
let appendedUpTo: number | undefined;

function queueRecord(event: LogRecord): void {
  outbox.push(event);
  outboxBytes += approxRecordBytes(event);
  if (outbox.length >= RECORD_BATCH_RECORDS || outboxBytes >= RECORD_BATCH_BYTES) {
    sendRecords();
    return;
  }
  scheduleRecords();
}

function scheduleRecords(): void {
  outboxTimer ??= setTimeout(sendRecords, Math.max(0, outboxSentAt + RECORD_BATCH_MS - Date.now()));
}

function sendRecords(): void {
  if (outboxTimer !== undefined) {
    clearTimeout(outboxTimer);
    outboxTimer = undefined;
  }
  if ((outbox.length === 0 && appendedUpTo === undefined) || manager === undefined) {
    return;
  }
  const events = outbox;
  outbox = [];
  outboxBytes = 0;
  outboxSentAt = Date.now();
  const acked = appendedUpTo;
  appendedUpTo = undefined;
  postMessage({ type: "appended", events, stats: manager.snapshot(), appendedUpTo: acked } satisfies WorkerResponse);
}

function holdFor(mgr: LogManager): ChunkHoldQueue<ChunkMessage> {
  hold ??= new ChunkHoldQueue<ChunkMessage>(
    (message, force) => mgr.acceptChunk(message, force),
    (message) => reply({ id: message.id, type: "chunkAck", accepted: true, stats: mgr.snapshot() }),
  );
  return hold;
}

function scheduleRetry(): void {
  if (retryTimer !== undefined || hold?.holding !== true) {
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    hold?.retry();
    scheduleRetry();
  }, HELD_RETRY_MS);
}

function reply(message: WorkerResponse): void {
  // A result must not overtake the records its caller expects to have seen.
  if (message.type === "result" || message.type === "error") {
    sendRecords();
  }
  postMessage(message);
}

function fail(id: number | undefined, err: unknown): void {
  if (id === undefined) {
    return;
  }
  reply({ id, type: "error", error: err instanceof Error ? err.message : String(err) });
}

async function handle(message: WorkerRequest): Promise<void> {
  if (message.type === "init") {
    detector = new Detector(message.config.extraMarkers, message.config.extraPatterns, message.config.redact !== false);
    manager = new LogManager(
      message.config.max,
      undefined,
      detector,
      message.config.persist,
      message.config.directory,
      message.config.sessionID,
      message.config.retentionDays,
      message.config.maxSessionLogs,
      {
        repoKey: message.config.repoKey,
        maxMemoryBytes: message.config.maxMemoryBytes,
        maxSessionBytes: message.config.maxSessionBytes,
        maxSpoolBytes: message.config.maxSpoolBytes,
        maxTotalBytes: message.config.maxTotalBytes,
        spoolDir: message.config.spoolDir,
      },
    );
    manager.setParsers([defaultLogParser()]);
    manager.setOnRecord(queueRecord);
    reply({ type: "ready" });
    return;
  }
  if (message.type === "setSecrets") {
    detector?.update(message.extraMarkers, message.extraPatterns, message.redact);
    return;
  }
  if (message.type === "setServiceLogs") {
    manager?.setServiceLogs(message.logs);
    return;
  }
  if (message.type === "setPluginPaths") {
    // Resolve against the repo root (not the worker's cwd) so relative plugin
    // paths and the repo-root containment check match the supervisor's.
    const registry = await loadPluginPaths(message.paths, message.repoRoot);
    manager?.setParsers(registry.logParsers);
    return;
  }
  if (!manager) {
    fail("id" in message ? message.id : undefined, new Error("log worker is not initialized"));
    return;
  }
  if (message.type === "appendBatch") {
    for (const item of message.items) {
      manager.append(item.event, item.atMs);
    }
    appendedUpTo = message.items.at(-1)?.id ?? appendedUpTo;
    scheduleRecords();
    return;
  }
  if (message.type === "setUpstreamPaused") {
    manager.setUpstreamPaused(message.paused);
    return;
  }
  if (message.type === "chunk") {
    if (!holdFor(manager).offer(message)) {
      scheduleRetry();
    }
    return;
  }
  if (message.type === "setMemoryBudget") {
    manager.setMemoryBudget(message.bytes);
    return;
  }
  if (message.type === "flush") {
    hold?.retry();
    await manager.flush();
    reply({ id: message.id, type: "result", result: null });
    return;
  }
  if (message.type === "query") {
    reply({ id: message.id, type: "result", result: manager.query(message.filter) });
    return;
  }
  if (message.type === "queryPage") {
    reply({ id: message.id, type: "result", result: manager.queryPage(message.filter, message.page) });
    return;
  }
  if (message.type === "historyPage") {
    reply({ id: message.id, type: "result", result: manager.historyPage(message.session, message.filter, message.page) });
    return;
  }
  if (message.type === "queryFacets") {
    reply({ id: message.id, type: "result", result: manager.queryFacets(message.filter) });
    return;
  }
  if (message.type === "exportTo") {
    manager.exportTo(message.path, message.filter);
    reply({ id: message.id, type: "result", result: null });
    return;
  }
  // Held chunks go in past the budget rather than being lost at shutdown.
  hold?.retry(true);
  await manager.close();
  reply({ id: message.id, type: "result", result: null });
}

addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const data = event.data;
  // The budget must not wait behind a flood of chunks.
  if (data.type === "setMemoryBudget") {
    void handle(data);
    return;
  }
  chain = chain.then(() => handle(data)).catch((err: unknown) => {
    fail("id" in data ? data.id : undefined, err);
  });
});
