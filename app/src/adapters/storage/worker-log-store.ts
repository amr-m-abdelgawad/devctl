import type { ServiceLogConfig } from "../../domain/config/types.ts";
import type { LogFacets, LogFilter, LogIngest, LogPage, LogPageRequest, LogParser, LogRecord } from "../../domain/logs/logs.ts";
import { LogBatcher } from "../../domain/logs/batch.ts";
import { CREDIT_PER_STREAM_BYTES, CREDIT_TOTAL_BYTES } from "../../domain/logs/budgets.ts";
import type { LogSnapshot, LogStore } from "../../ports/log-store.ts";
import { Bus, LogBatch, LogReceived, newEvent } from "../../shared/events.ts";
import { Detector } from "../secrets/detector.ts";
import { AppendLane, type LaneItem } from "./append-lane.ts";
import { inProcessLogStore, LogManager } from "./logs.ts";
import { resolveWorkerUrl } from "./worker-resolver.ts";
import type { WorkerLogConfig, WorkerRequest, WorkerResponse, WorkerRpcBody } from "./log-worker-protocol.ts";

export type { WorkerLogConfig } from "./log-worker-protocol.ts";

type WorkerChunk = { service: string; stream: string; pid: number; readAtMs: number; bytes: Uint8Array; end?: boolean };

export const WORKER_INIT_TIMEOUT_MS = 500;
export const WORKER_RPC_TIMEOUT_MS = 10_000;
export const WORKER_CLOSE_TIMEOUT_MS = 2_000;
// A worker lost after it was ready is replaced this many times before the in-process store takes over.
const WORKER_RESTARTS = 1;

const DEFAULT_WORKER_SCRIPT = resolveWorkerUrl("log-worker", new URL("./log-worker.ts", import.meta.url));

type Pending = {
  readonly resolve: (value: LogRecord[] | LogPage | LogFacets | null) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export type WorkerLogStoreOptions = {
  script?: URL;
};

export type CreateDaemonLogStoreOptions = {
  standalone?: boolean;
  script?: URL;
  initTimeoutMs?: number;
  /** Tests that want the historical in-process store. Production tries the worker in every build. */
  forceInProcess?: boolean;
};

export class WorkerLogStore implements LogStore {
  private worker: Worker;
  private readonly script: URL;
  // Workers this store stopped or replaced; their late events are ignored.
  private readonly retired = new WeakSet<Worker>();
  private restarts = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private readonly config: WorkerLogConfig;
  private readonly bus?: Bus;
  private fallback?: LogStore;
  private fallbackDetector?: Detector;
  // The latest of each setting, applied again to a replacement worker or the in-process store.
  private serviceLogs?: Record<string, ServiceLogConfig>;
  private parsers?: { parsers: LogParser[]; pluginPaths: string[]; repoRoot?: string };
  private secrets?: { extraMarkers: string[]; extraPatterns: string[]; redact?: boolean };
  private memoryBudget?: number;
  // The highest seq seen, so a replacement's records sort after the ones already published.
  private maxSeq = 0;
  private closing = false;
  private readonly lane = new AppendLane((items) => this.sendAppends(items));
  // Streams whose reader holds a chunk this store refused, and whether the worker was told.
  private readonly refusedStreams = new Set<string>();
  private upstreamPaused = false;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stats: LogSnapshot = { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 };
  private dead = false;
  private unacked = 0;
  private readonly unackedByStream = new Map<string, number>();
  private readonly inflight = new Map<number, { bytes: number; key: string; chunk: WorkerChunk }>();
  private readonly batcher: LogBatcher;
  private pipeline: LogSnapshot["pipeline"];
  private readySettled = false;
  private readonly ready: Promise<void>;
  private resolveReady: () => void = () => undefined;
  private rejectReady: (error: Error) => void = () => undefined;

  constructor(config: WorkerLogConfig, bus?: Bus, options: WorkerLogStoreOptions = {}) {
    this.config = config;
    this.bus = bus;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.script = options.script ?? DEFAULT_WORKER_SCRIPT;
    this.worker = this.spawn();
    this.batcher = new LogBatcher(config.sessionID, () => this.stats, (payload) => {
      this.bus?.publish(newEvent(LogBatch, payload.newest[0]?.service ?? "devctl", payload));
    });
    this.post({ type: "init", config });
  }

  private spawn(): Worker {
    const worker = new Worker(this.script, { name: "devctl-logs" });
    const current = (): boolean => worker === this.worker && !this.retired.has(worker);
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      if (current()) {
        this.onMessage(event.data);
      }
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      if (current()) {
        this.lost(new Error(event.message || "log worker failed"));
      }
    });
    // A worker can also exit with no error event at all (process.exit, a fatal crash).
    worker.addEventListener("close", () => {
      if (current()) {
        this.lost(new Error("log worker exited"));
      }
    });
    return worker;
  }

  waitUntilReady(timeoutMs = WORKER_INIT_TIMEOUT_MS): Promise<void> {
    if (this.dead) {
      return Promise.reject(new Error("log worker is not running"));
    }
    if (this.readySettled) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.markDead(new Error("log worker init timed out"));
      }, timeoutMs);
      this.ready.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Posts raw output to the worker within a credit window per stream and in
   * total. The worker acks a chunk only once its pipeline has taken it, so
   * unacked bytes are exactly what the worker still holds for us.
   */
  ingestChunk(chunk: WorkerChunk): boolean {
    if (this.fallback?.ingestChunk) {
      return this.fallback.ingestChunk(chunk);
    }
    if (this.dead) {
      return false;
    }
    const size = chunk.bytes.byteLength;
    const key = `${chunk.service}\0${chunk.stream}\0${chunk.pid}`;
    const streamUnacked = this.unackedByStream.get(key) ?? 0;
    // A window that holds nothing yet takes one chunk of any size, so an
    // oversized chunk cannot wait forever.
    const overStream = streamUnacked > 0 && streamUnacked + size > CREDIT_PER_STREAM_BYTES;
    const overTotal = this.unacked > 0 && this.unacked + size > CREDIT_TOTAL_BYTES;
    if (size > 0 && (overStream || overTotal)) {
      this.refusedStreams.add(key);
      this.noteUpstream();
      return false;
    }
    const id = this.nextId;
    this.nextId += 1;
    const copy = { ...chunk, bytes: new Uint8Array(chunk.bytes) };
    this.unacked += size;
    this.unackedByStream.set(key, streamUnacked + size);
    this.inflight.set(id, { bytes: size, key, chunk: copy });
    try {
      this.post(chunkMessage(id, copy));
    } catch (error) {
      this.release(id);
      this.lost(error instanceof Error ? error : new Error(String(error)));
      return this.fallback?.ingestChunk?.(chunk) ?? false;
    }
    this.refusedStreams.delete(key);
    this.noteUpstream();
    return true;
  }

  ingestPaused(): boolean {
    if (this.fallback?.ingestPaused) {
      return this.fallback.ingestPaused();
    }
    return this.unacked >= CREDIT_TOTAL_BYTES || this.pipeline?.paused === true || this.lane.backlogged();
  }

  setMemoryBudget(bytes: number): void {
    this.memoryBudget = bytes;
    if (this.fallback) {
      this.fallback.setMemoryBudget?.(bytes);
      return;
    }
    if (!this.dead) {
      this.post({ type: "setMemoryBudget", bytes });
    }
  }

  pipelineStats(): LogSnapshot["pipeline"] {
    const stats = this.fallback?.pipelineStats?.() ?? this.pipeline;
    if (this.lane.lost === 0) {
      return stats;
    }
    const base = stats ?? { inFlightBytes: 0, spooledBytes: 0, paused: false, loss: 0, ringBytes: 0 };
    return { ...base, loss: base.loss + this.lane.lost };
  }

  usesWorker(): boolean {
    return this.fallback === undefined && !this.dead;
  }

  async flush(): Promise<void> {
    if (this.fallback?.flush) {
      await this.fallback.flush();
      return;
    }
    await this.rpc({ type: "flush" });
    this.batcher.flush();
  }

  /** Queued in the lane with the time of the call, which is the record's event time. */
  append(event: LogIngest): void {
    if (this.fallback) {
      this.fallback.append(event);
      return;
    }
    if (this.dead) {
      return;
    }
    this.lane.push(event, Date.now());
    this.noteUpstream();
  }

  async query(filter: LogFilter): Promise<LogRecord[]> {
    const result = await this.rpc({ type: "query", filter });
    if (!Array.isArray(result)) {
      throw new Error("log worker query returned a non-array");
    }
    return result;
  }

  async queryPage(filter: LogFilter, page?: LogPageRequest): Promise<LogPage> {
    const result = await this.rpc({ type: "queryPage", filter, page });
    if (!isLogPage(result)) {
      throw new Error("log worker queryPage returned an unexpected payload");
    }
    return result;
  }

  /** Served by the worker, so reading a session's files never blocks the daemon's thread. */
  async historyPage(session: string, filter: LogFilter, page?: LogPageRequest): Promise<LogPage> {
    const result = await this.rpc({ type: "historyPage", session, filter, page });
    if (!isLogPage(result)) {
      throw new Error("log worker historyPage returned an unexpected payload");
    }
    return result;
  }

  async queryFacets(filter: LogFilter): Promise<LogFacets> {
    const result = await this.rpc({ type: "queryFacets", filter });
    if (!isLogFacets(result)) {
      throw new Error("log worker queryFacets returned an unexpected payload");
    }
    return result;
  }

  snapshot(): LogSnapshot {
    if (this.fallback) {
      return this.fallback.snapshot();
    }
    return this.stats;
  }

  async exportTo(path: string, filter: LogFilter): Promise<void> {
    await this.rpc({ type: "exportTo", path, filter });
  }

  setParsers(parsers: LogParser[], pluginPaths?: readonly string[], repoRoot?: string): void {
    this.parsers = { parsers, pluginPaths: [...(pluginPaths ?? [])], repoRoot };
    if (this.fallback) {
      this.fallback.setParsers(parsers, pluginPaths, repoRoot);
      return;
    }
    if (this.dead) {
      return;
    }
    this.post({ type: "setPluginPaths", paths: this.parsers.pluginPaths, repoRoot });
  }

  setServiceLogs(logs: Record<string, ServiceLogConfig>): void {
    this.serviceLogs = logs;
    if (this.fallback) {
      this.fallback.setServiceLogs(logs);
      return;
    }
    if (this.dead) {
      return;
    }
    this.post({ type: "setServiceLogs", logs });
  }

  setSecrets(extraMarkers: string[], extraPatterns: string[], redact?: boolean): void {
    this.secrets = { extraMarkers, extraPatterns, redact };
    if (this.fallbackDetector) {
      this.fallbackDetector.update(extraMarkers, extraPatterns, redact);
      return;
    }
    if (this.dead) {
      return;
    }
    this.post({ type: "setSecrets", extraMarkers, extraPatterns, redact });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearRestartTimer();
    if (this.fallback) {
      await this.fallback.close();
      return;
    }
    try {
      await this.rpc({ type: "close" }, WORKER_CLOSE_TIMEOUT_MS);
    } catch {
      // Terminate below even when the close RPC never comes back.
    } finally {
      this.markDead(new Error("log worker closed"));
    }
  }

  // A worker that fails while starting is only reported: the caller picks
  // the in-process store. One that fails later is replaced once, and after
  // that the in-process store takes over.
  private lost(error: Error): void {
    if (this.closing || this.fallback || this.dead || !this.readySettled) {
      this.markDead(error);
      return;
    }
    if (this.restarts < WORKER_RESTARTS) {
      this.restart(error);
      return;
    }
    this.failOver(error);
  }

  // The replacement gets the session's settings, then every chunk and
  // structured append the lost worker never acked, in their order and ahead
  // of anything new. It continues the session's seqs and spool.
  private restart(error: Error): void {
    this.restarts += 1;
    this.retire(this.worker);
    this.rejectAll(error);
    this.worker = this.spawn();
    this.upstreamPaused = false;
    try {
      this.post({ type: "init", config: { ...this.config, firstSeq: this.maxSeq + 1 } });
      this.postSettings();
      for (const [id, row] of this.inflight) {
        this.post(chunkMessage(id, row.chunk));
      }
    } catch (err) {
      this.failOver(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.noteUpstream();
    this.lane.resend();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.lost(new Error("log worker restart timed out"));
    }, WORKER_INIT_TIMEOUT_MS);
  }

  private postSettings(): void {
    if (this.serviceLogs !== undefined) {
      this.post({ type: "setServiceLogs", logs: this.serviceLogs });
    }
    if (this.parsers !== undefined) {
      this.post({ type: "setPluginPaths", paths: this.parsers.pluginPaths, repoRoot: this.parsers.repoRoot });
    }
    if (this.secrets !== undefined) {
      this.post({ type: "setSecrets", ...this.secrets });
    }
    if (this.memoryBudget !== undefined) {
      this.post({ type: "setMemoryBudget", bytes: this.memoryBudget });
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  // The in-process store takes over what the worker never acked: structured
  // appends with their event times, and the chunks it still held. It gets
  // the session's settings first, and continues its seqs and spool.
  private failOver(error: Error): void {
    this.clearRestartTimer();
    if (this.fallback || this.closing) {
      this.markDead(error);
      return;
    }
    const missed = this.lane.takeUnacked();
    const chunks = [...this.inflight.values()].map((row) => row.chunk);
    this.inflight.clear();
    this.unacked = 0;
    this.unackedByStream.clear();
    this.refusedStreams.clear();
    this.markDead(error);
    const secrets = this.secrets ?? { extraMarkers: this.config.extraMarkers, extraPatterns: this.config.extraPatterns, redact: this.config.redact };
    this.fallbackDetector = new Detector(secrets.extraMarkers, secrets.extraPatterns, secrets.redact);
    const manager = managerFromConfig({ ...this.config, firstSeq: this.maxSeq + 1 }, this.bus ?? new Bus(1), this.fallbackDetector);
    const store = inProcessLogStore(manager);
    if (this.serviceLogs !== undefined) {
      store.setServiceLogs(this.serviceLogs);
    }
    if (this.parsers !== undefined) {
      store.setParsers(this.parsers.parsers, this.parsers.pluginPaths, this.parsers.repoRoot);
    }
    if (this.memoryBudget !== undefined) {
      store.setMemoryBudget?.(this.memoryBudget);
    }
    this.fallback = store;
    for (const item of missed) {
      manager.append(item.event, item.atMs);
    }
    for (const chunk of chunks) {
      store.ingestChunk?.(chunk);
    }
    this.dead = false;
  }

  // Posted in lane order; a failed post leaves the batch unacked for the takeover.
  private sendAppends(items: LaneItem[]): boolean {
    if (this.dead || this.fallback) {
      return false;
    }
    try {
      this.post({ type: "appendBatch", items });
      return true;
    } catch (error) {
      queueMicrotask(() => this.lost(error instanceof Error ? error : new Error(String(error))));
      return false;
    }
  }

  // Tells the worker while output is held back here, so a fold that may still
  // get older lines is not closed by its idle timer.
  private noteUpstream(): void {
    const paused = this.refusedStreams.size > 0 || this.unacked >= CREDIT_TOTAL_BYTES || this.lane.backlogged();
    if (paused === this.upstreamPaused || this.dead || this.fallback) {
      return;
    }
    this.upstreamPaused = paused;
    try {
      this.post({ type: "setUpstreamPaused", paused });
    } catch {
      // the next post fails over
    }
  }

  private rpc(body: WorkerRpcBody, timeoutMs = WORKER_RPC_TIMEOUT_MS): Promise<LogRecord[] | LogPage | LogFacets | null> {
    if (this.fallback) {
      return this.fallbackRpc(body);
    }
    this.assertAlive();
    // A request sees every append made before it.
    this.lane.sendAll();
    const id = this.nextId;
    this.nextId += 1;
    const message: WorkerRequest = { ...body, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A slow page/facet/export must not kill ingest. The ring keeps
        // wrapping; only this RPC fails.
        const waiting = this.pending.get(id);
        if (!waiting) {
          return;
        }
        this.pending.delete(id);
        waiting.reject(new Error(`log worker timed out (${body.type})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.post(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async fallbackRpc(body: WorkerRpcBody): Promise<LogRecord[] | LogPage | LogFacets | null> {
    const store = this.fallback;
    if (!store) {
      throw new Error("log worker is not running");
    }
    if (body.type === "query") {
      return store.query(body.filter);
    }
    if (body.type === "queryPage") {
      return store.queryPage(body.filter, body.page);
    }
    if (body.type === "historyPage") {
      if (store.historyPage === undefined) {
        throw new Error("log store has no session history");
      }
      return store.historyPage(body.session, body.filter, body.page);
    }
    if (body.type === "queryFacets") {
      return store.queryFacets(body.filter);
    }
    if (body.type === "exportTo") {
      await store.exportTo(body.path, body.filter);
      return null;
    }
    if (body.type === "flush") {
      await store.flush?.();
      return null;
    }
    await store.close();
    return null;
  }

  private post(message: WorkerRequest): void {
    this.assertAlive();
    this.worker.postMessage(message);
  }

  private onMessage(message: WorkerResponse): void {
    if (message.type === "ready") {
      this.settleReady();
      this.clearRestartTimer();
      return;
    }
    if (message.type === "appended") {
      this.stats = message.stats;
      this.pipeline = message.stats.pipeline ?? this.pipeline;
      for (const event of message.events) {
        this.maxSeq = Math.max(this.maxSeq, event.seq);
        this.bus?.publish(newEvent(LogReceived, event.service, { event, level: event.severityText }));
        this.batcher.push(event);
      }
      // The worker already batched these; a second interval here would double the latency.
      this.batcher.flush();
      if (message.appendedUpTo !== undefined) {
        this.lane.ack(message.appendedUpTo);
        this.noteUpstream();
      }
      return;
    }
    if (message.type === "chunkAck") {
      this.onChunkAck(message.id, message.accepted, message.stats);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === "error") {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private onChunkAck(id: number, accepted: boolean, stats: LogSnapshot): void {
    const row = this.release(id);
    this.stats = stats;
    this.pipeline = stats.pipeline ?? this.pipeline;
    if (!accepted && row && this.fallback?.ingestChunk) {
      this.fallback.ingestChunk(row.chunk);
    }
    this.noteUpstream();
  }

  private release(id: number): { bytes: number; key: string; chunk: WorkerChunk } | undefined {
    const row = this.inflight.get(id);
    if (row === undefined) {
      return undefined;
    }
    this.inflight.delete(id);
    this.unacked = Math.max(0, this.unacked - row.bytes);
    const left = (this.unackedByStream.get(row.key) ?? 0) - row.bytes;
    if (left > 0) {
      this.unackedByStream.set(row.key, left);
    } else {
      this.unackedByStream.delete(row.key);
    }
    return row;
  }

  private settleReady(): void {
    if (this.readySettled || this.dead) {
      return;
    }
    this.readySettled = true;
    this.resolveReady();
  }

  private assertAlive(): void {
    if (this.dead) {
      throw new Error("log worker is not running");
    }
  }

  private markDead(error: Error): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    this.rejectAll(error);
    this.retire(this.worker);
  }

  // Stops a worker this store no longer uses; its close event is expected.
  private retire(worker: Worker): void {
    this.retired.add(worker);
    setTimeout(() => {
      try {
        void worker.terminate();
      } catch {
        // already gone
      }
    }, 0);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function chunkMessage(id: number, chunk: WorkerChunk): WorkerRequest {
  return { id, type: "chunk", service: chunk.service, stream: chunk.stream, pid: chunk.pid, readAtMs: chunk.readAtMs, bytes: chunk.bytes, end: chunk.end };
}

function isLogPage(value: LogRecord[] | LogPage | LogFacets | null): value is LogPage {
  if (value === null || Array.isArray(value) || !("events" in value)) {
    return false;
  }
  return Array.isArray(value.events);
}

function isLogFacets(value: LogRecord[] | LogPage | LogFacets | null): value is LogFacets {
  return value !== null && !Array.isArray(value) && "byService" in value;
}

function inProcessFromConfig(config: WorkerLogConfig, bus: Bus, detector: Detector): LogStore {
  return inProcessLogStore(managerFromConfig(config, bus, detector));
}

function managerFromConfig(config: WorkerLogConfig, bus: Bus, detector: Detector): LogManager {
  return new LogManager(
    config.max,
    bus,
    detector,
    config.persist,
    config.directory,
    config.sessionID,
    config.retentionDays,
    config.maxSessionLogs,
    {
      repoKey: config.repoKey,
      maxMemoryBytes: config.maxMemoryBytes,
      maxSessionBytes: config.maxSessionBytes,
      maxSpoolBytes: config.maxSpoolBytes,
      maxTotalBytes: config.maxTotalBytes,
      spoolDir: config.spoolDir,
      firstSeq: config.firstSeq,
    },
  );
}

export async function createDaemonLogStore(
  config: WorkerLogConfig,
  bus: Bus,
  detector: Detector,
  options: CreateDaemonLogStoreOptions = {},
): Promise<{ logs: LogStore; usingWorker: boolean }> {
  const standalone = options.standalone ?? false;
  if (standalone && options.script === undefined && options.forceInProcess === true) {
    return { logs: inProcessFromConfig(config, bus, detector), usingWorker: false };
  }
  try {
    const store = new WorkerLogStore(config, bus, { script: options.script });
    await store.waitUntilReady(options.initTimeoutMs ?? WORKER_INIT_TIMEOUT_MS);
    return { logs: store, usingWorker: true };
  } catch {
    return { logs: inProcessFromConfig(config, bus, detector), usingWorker: false };
  }
}
