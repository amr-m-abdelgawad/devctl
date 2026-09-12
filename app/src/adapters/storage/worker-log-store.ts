import type { LogFacets, LogFilter, LogIngest, LogPage, LogPageRequest, LogParser, LogRecord } from "../../domain/logs/logs.ts";
import type { LogSnapshot, LogStore } from "../../ports/log-store.ts";
import { LogReceived, newEvent, type Bus } from "../../shared/events.ts";
import { Detector } from "../secrets/detector.ts";
import { inProcessLogStore, LogManager } from "./logs.ts";
import type { WorkerLogConfig, WorkerRequest, WorkerResponse, WorkerRpcBody } from "./log-worker-protocol.ts";

export type { WorkerLogConfig } from "./log-worker-protocol.ts";

export const WORKER_INIT_TIMEOUT_MS = 500;
export const WORKER_RPC_TIMEOUT_MS = 10_000;
export const WORKER_CLOSE_TIMEOUT_MS = 2_000;

const DEFAULT_WORKER_SCRIPT = new URL("./log-worker.ts", import.meta.url);

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
};

export class WorkerLogStore implements LogStore {
  private readonly worker: Worker;
  private readonly bus?: Bus;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stats: LogSnapshot = { total: 0, errors: 0, counts: {} };
  private dead = false;
  private readySettled = false;
  private readonly ready: Promise<void>;
  private resolveReady: () => void = () => undefined;
  private rejectReady: (error: Error) => void = () => undefined;

  constructor(config: WorkerLogConfig, bus?: Bus, options: WorkerLogStoreOptions = {}) {
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
      this.markDead(new Error(event.message || "log worker failed"));
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

  append(event: LogIngest): void {
    if (this.dead) {
      return;
    }
    try {
      this.post({ type: "append", event });
    } catch {
      // Worker already gone — drop the line rather than throw on the ingest path.
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

  async queryFacets(filter: LogFilter): Promise<LogFacets> {
    const result = await this.rpc({ type: "queryFacets", filter });
    if (!isLogFacets(result)) {
      throw new Error("log worker queryFacets returned an unexpected payload");
    }
    return result;
  }

  snapshot(): LogSnapshot {
    return this.stats;
  }

  async exportTo(path: string, filter: LogFilter): Promise<void> {
    await this.rpc({ type: "exportTo", path, filter });
  }

  setParsers(_parsers: LogParser[], pluginPaths?: readonly string[]): void {
    if (this.dead) {
      return;
    }
    this.post({ type: "setPluginPaths", paths: [...(pluginPaths ?? [])] });
  }

  setSecrets(extraMarkers: string[], extraPatterns: string[]): void {
    if (this.dead) {
      return;
    }
    this.post({ type: "setSecrets", extraMarkers, extraPatterns });
  }

  async close(): Promise<void> {
    if (this.dead) {
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

  private rpc(body: WorkerRpcBody, timeoutMs = WORKER_RPC_TIMEOUT_MS): Promise<LogRecord[] | LogPage | LogFacets | null> {
    this.assertAlive();
    const id = this.nextId;
    this.nextId += 1;
    const message: WorkerRequest = { ...body, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.markDead(new Error(`log worker timed out (${body.type})`));
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
      this.stats = message.stats;
      this.bus?.publish(newEvent(LogReceived, message.event.service, { event: message.event, level: message.event.severityText }));
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
    try {
      this.worker.terminate();
    } catch {
      // already gone
    }
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
    ),
  );
}

export async function createDaemonLogStore(
  config: WorkerLogConfig,
  bus: Bus,
  detector: Detector,
  options: CreateDaemonLogStoreOptions = {},
): Promise<{ logs: LogStore; usingWorker: boolean }> {
  const standalone = options.standalone ?? Bun.isStandaloneExecutable === true;
  if (standalone) {
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
