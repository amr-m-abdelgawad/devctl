import type { ServiceLogConfig } from "../../domain/config/types.ts";
import type { LogFacets, LogFilter, LogIngest, LogPage, LogPageRequest, LogParser, LogRecord } from "../../domain/logs/logs.ts";
import { LogBatcher } from "../../domain/logs/batch.ts";
import { CREDIT_PER_STREAM_BYTES, CREDIT_TOTAL_BYTES } from "../../domain/logs/budgets.ts";
import type { LogSnapshot, LogStore } from "../../ports/log-store.ts";
import { Bus, LogBatch, LogReceived, newEvent } from "../../shared/events.ts";
import { Detector } from "../secrets/detector.ts";
import { inProcessLogStore, LogManager } from "./logs.ts";
import { resolveWorkerUrl } from "./worker-resolver.ts";
import type { WorkerLogConfig, WorkerRequest, WorkerResponse, WorkerRpcBody } from "./log-worker-protocol.ts";

export type { WorkerLogConfig } from "./log-worker-protocol.ts";

type WorkerChunk = { service: string; stream: string; pid: number; readAtMs: number; bytes: Uint8Array; end?: boolean };

export const WORKER_INIT_TIMEOUT_MS = 500;
export const WORKER_RPC_TIMEOUT_MS = 10_000;
export const WORKER_CLOSE_TIMEOUT_MS = 2_000;

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
  private readonly worker: Worker;
  private readonly config: WorkerLogConfig;
  private readonly bus?: Bus;
  private fallback?: LogStore;
  private closing = false;
  private readonly pendingReplay: LogIngest[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stats: LogSnapshot = { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 };
  private dead = false;
  private shed = false;
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
    this.worker = new Worker(options.script ?? DEFAULT_WORKER_SCRIPT, { name: "devctl-logs" });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      this.onMessage(event.data);
    });
    this.worker.addEventListener("error", (event: ErrorEvent) => {
      this.failOver(new Error(event.message || "log worker failed"));
    });
    this.batcher = new LogBatcher(config.sessionID, () => this.stats, (payload) => {
      this.bus?.publish(newEvent(LogBatch, payload.newest[0]?.service ?? "devctl", payload));
    });
    this.post({ type: "init", config });
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
    if (this.shed || this.dead) {
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
      return false;
    }
    const id = this.nextId;
    this.nextId += 1;
    const copy = { ...chunk, bytes: new Uint8Array(chunk.bytes) };
    this.unacked += size;
    this.unackedByStream.set(key, streamUnacked + size);
    this.inflight.set(id, { bytes: size, key, chunk: copy });
    try {
      this.post({ id, type: "chunk", service: copy.service, stream: copy.stream, pid: copy.pid, readAtMs: copy.readAtMs, bytes: copy.bytes, end: copy.end });
    } catch (error) {
      this.release(id);
      this.failOver(error instanceof Error ? error : new Error(String(error)));
      return this.fallback?.ingestChunk?.(chunk) ?? false;
    }
    return true;
  }

  ingestPaused(): boolean {
    if (this.fallback?.ingestPaused) {
      return this.fallback.ingestPaused();
    }
    return this.shed || this.unacked >= CREDIT_TOTAL_BYTES || this.pipeline?.paused === true;
  }

  setMemoryBudget(bytes: number): void {
    if (this.fallback) {
      this.fallback.setMemoryBudget?.(bytes);
      return;
    }
    if (!this.dead) {
      this.post({ type: "setMemoryBudget", bytes });
    }
  }

  setIngestShed(shed: boolean): void {
    this.shed = shed;
    if (this.fallback) {
      this.fallback.setIngestShed?.(shed);
      return;
    }
    if (!this.dead) {
      this.post({ type: "setIngestShed", shed });
    }
  }

  pipelineStats(): LogSnapshot["pipeline"] {
    return this.fallback?.pipelineStats?.() ?? this.pipeline;
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

  append(event: LogIngest): void {
    if (this.fallback) {
      this.fallback.append(event);
      return;
    }
    this.pendingReplay.push(event);
    if (this.dead) {
      return;
    }
    try {
      this.post({ type: "append", event });
    } catch (error) {
      this.failOver(error instanceof Error ? error : new Error(String(error)));
    }
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

  setParsers(_parsers: LogParser[], pluginPaths?: readonly string[], repoRoot?: string): void {
    if (this.dead) {
      return;
    }
    this.post({ type: "setPluginPaths", paths: [...(pluginPaths ?? [])], repoRoot });
  }

  setServiceLogs(logs: Record<string, ServiceLogConfig>): void {
    if (this.dead) {
      return;
    }
    this.post({ type: "setServiceLogs", logs });
  }

  setSecrets(extraMarkers: string[], extraPatterns: string[], redact?: boolean): void {
    if (this.dead) {
      return;
    }
    this.post({ type: "setSecrets", extraMarkers, extraPatterns, redact });
  }

  async close(): Promise<void> {
    this.closing = true;
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

  private failOver(error: Error): void {
    if (this.fallback || this.closing) {
      this.markDead(error);
      return;
    }
    const missed = this.pendingReplay.splice(0, this.pendingReplay.length);
    const chunks = [...this.inflight.values()].map((row) => row.chunk);
    this.inflight.clear();
    this.unacked = 0;
    this.unackedByStream.clear();
    this.markDead(error);
    this.fallback = inProcessFromConfig(this.config, this.bus ?? new Bus(1), new Detector(this.config.extraMarkers, this.config.extraPatterns, this.config.redact));
    for (const event of missed) {
      this.fallback.append(event);
    }
    for (const chunk of chunks) {
      this.fallback.ingestChunk?.(chunk);
    }
    this.dead = false;
  }

  private rpc(body: WorkerRpcBody, timeoutMs = WORKER_RPC_TIMEOUT_MS): Promise<LogRecord[] | LogPage | LogFacets | null> {
    if (this.fallback) {
      return this.fallbackRpc(body);
    }
    this.assertAlive();
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
      return;
    }
    if (message.type === "appended") {
      this.pendingReplay.shift();
      this.stats = message.stats;
      this.pipeline = message.stats.pipeline ?? this.pipeline;
      this.bus?.publish(newEvent(LogReceived, message.event.service, { event: message.event, level: message.event.severityText }));
      this.batcher.push(message.event);
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
    const worker = this.worker;
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
  return inProcessLogStore(
    new LogManager(
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
      },
    ),
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
