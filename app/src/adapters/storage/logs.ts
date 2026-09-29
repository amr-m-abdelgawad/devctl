import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Bus, LogBatch, LogReceived, newEvent } from "../../shared/events.ts";
import { type Detector } from "../secrets/detector.ts";
import type { LogSnapshot, LogStore } from "../../ports/log-store.ts";
import { ensureDir, exportsDir, logsDir, resolveUserPath } from "./storage.ts";
import { LogRing } from "./log-ring.ts";
import { SessionLogWriter } from "./log-persist.ts";
import { HISTORY_SCAN_BYTES, HISTORY_SCAN_MS, PROCESS_SLICE_MS } from "../../domain/logs/budgets.ts";
import { LogBatcher } from "../../domain/logs/batch.ts";
import { IngestPipeline, type PipelineChunk } from "./ingest/pipeline.ts";

import type { ServiceLogConfig } from "../../domain/config/types.ts";
import {
  buildLogRecord,
  clampLogPageSize,
  createLogMatcher,
  createSearchMatcher,
  dedupeLogsByRequestId,
  isErrorSeverity,
  PROXY_HOP_CORRELATE_WINDOW_MS,
  requestIdAttribute,
  shouldTagServiceLogWithProxyHop,
  withRequestId,
  isPlainObject,
  isProcessLogSource,
  matchesLogDimensions,
  MultilineAssembler,
  parseJSONLogLine,
  parseLogLine,
  redactLogRecord,
  shouldDropAccessLine,
  SeverityUnspecified,
  truncateLogLine,
  type FoldedLog,
  type LogFacets,
  type LogFilter,
  type LogIngest,
  type LogPage,
  type LogPageDirection,
  type LogPageRequest,
  type LogParser,
  type LogRecord,
  type ParsedLog,
} from "../../domain/logs/logs.ts";
export * from "../../domain/logs/logs.ts";

const DEFAULT_MAX_EVENTS = 50_000;
const SESSION_PREFIX = "session-";
const SESSION_FORMAT_FILE = "FORMAT";
const SESSION_FORMAT_JSONL = "jsonl";

type LogCursor = { session: string; seq: number };

type CorrelateCandidate = {
  readonly event: LogRecord;
  readonly arrivedMs: number;
};

function encodeLogCursor(c: LogCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeLogCursor(raw: string): LogCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { session?: unknown }).session === "string" &&
      typeof (parsed as { seq?: unknown }).seq === "number"
    ) {
      return parsed as LogCursor;
    }
  } catch {
    // malformed cursor — treated as absent by callers
  }
  return undefined;
}

function accessLineKey(service: string, pid: number): string {
  return `${service}\0${pid}`;
}

function withoutFilterDimension(filter: LogFilter, dimension: "services" | "level" | "source"): LogFilter {
  const copy = { ...filter };
  copy[dimension] = undefined;
  return copy;
}

export type LogManagerOptions = {
  /** 0 keeps the historical count-only ring. */
  maxMemoryBytes?: number;
  pendingLimitBytes?: number;
  /** When set, `max_session_logs` counts only this repository's sessions. */
  repoKey?: string;
  /** 0 uses the 1 GiB session default inside the writer. */
  maxSessionBytes?: number;
  maxSpoolBytes?: number;
  /** 0 skips the cross-session byte prune. The daemon passes the 2 GiB default. */
  maxTotalBytes?: number;
  spoolDir?: string;
};

export class LogManager {
  private nextSeq = 1;
  private recorded = 0;
  private errorCount = 0;
  private readonly ring: LogRing;
  private readonly max: number;
  private readonly bus?: Bus;
  private readonly detector?: Detector;
  private readonly persistDir: string;
  private readonly persist: boolean;
  private readonly sessionID: string;
  private writer?: SessionLogWriter;
  private parsers: LogParser[] = [];
  private readonly assembler = new MultilineAssembler();
  private serviceLogs = new Map<string, ServiceLogConfig>();
  private lastByServicePid = new Map<string, LogRecord>();
  private recentCorrelate: CorrelateCandidate[] = [];
  private idleTimer?: ReturnType<typeof setTimeout>;
  private onRecord?: (event: LogRecord) => void;
  private pipeline?: IngestPipeline;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private batcher?: LogBatcher;
  private ingestShed = false;
  private readonly byteBudget: number;
  private readonly logRoot: string;
  private readonly repoKey: string;
  private readonly retentionDays: number;
  private readonly spoolDir: string;
  private readonly maxSpoolBytes: number;

  constructor(
    max: number,
    bus: Bus | undefined,
    detector: Detector | undefined,
    persist: boolean,
    directory: string,
    sessionID: string,
    retentionDays = 0,
    maxSessionLogs = 0,
    options: LogManagerOptions = {},
  ) {
    this.max = max > 0 ? max : DEFAULT_MAX_EVENTS;
    this.byteBudget = options.maxMemoryBytes ?? 0;
    this.ring = new LogRing(this.max, this.byteBudget);
    this.bus = bus;
    this.detector = detector;
    this.sessionID = sessionID;
    this.repoKey = options.repoKey ?? "";
    this.retentionDays = retentionDays;
    this.maxSpoolBytes = options.maxSpoolBytes ?? 0;
    const root = directory === "" || directory.startsWith("~/") ? logsDir() : directory;
    this.logRoot = root;
    this.persist = persist && sessionID !== "";
    this.persistDir = this.persist ? join(root, `${SESSION_PREFIX}${sessionID}`) : "";
    this.spoolDir = options.spoolDir ?? "";
    if (this.persist) {
      mkdirSync(this.persistDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.persistDir, SESSION_FORMAT_FILE), `${SESSION_FORMAT_JSONL}\n`, { mode: 0o600 });
      this.writer = new SessionLogWriter(this.persistDir, options.pendingLimitBytes, {
        maxSessionBytes: options.maxSessionBytes,
        maxSpoolBytes: options.maxSpoolBytes,
      });
      this.writeManifest(false);
      pruneSessions(root, retentionDays, maxSessionLogs, options.repoKey, {
        maxTotalBytes: options.maxTotalBytes ?? 0,
        liveDir: this.persistDir,
      });
    }
  }

  sessionDir(): string {
    return this.persistDir;
  }

  setParsers(parsers: LogParser[]): void {
    this.parsers = parsers;
  }

  setServiceLogs(logs: Record<string, ServiceLogConfig>): void {
    this.serviceLogs = new Map(Object.entries(logs));
  }

  setOnRecord(handler: ((event: LogRecord) => void) | undefined): void {
    this.onRecord = handler;
  }

  acceptChunk(chunk: Omit<PipelineChunk, "session" | "bytes"> & { bytes: Uint8Array }): boolean {
    if (this.ingestShed) {
      return false;
    }
    const pipeline = this.ensurePipeline();
    const accepted = pipeline.enqueueChunk({
      session: this.sessionID,
      service: chunk.service,
      stream: chunk.stream,
      pid: chunk.pid,
      readAtMs: chunk.readAtMs,
      bytes: Buffer.from(chunk.bytes),
    });
    this.scheduleDrain();
    return accepted;
  }

  setIngestShed(shed: boolean): void {
    this.ingestShed = shed;
  }

  ingestPaused(): boolean {
    return this.ingestShed || this.persistencePaused() || this.pipeline?.paused === true;
  }

  pipelineStats(): LogSnapshot["pipeline"] {
    if (this.pipeline === undefined && this.writer === undefined) {
      return undefined;
    }
    return {
      inFlightBytes: this.pipeline?.inFlightBytes() ?? 0,
      spooledBytes: (this.pipeline?.spooledBytes() ?? 0) + (this.writer?.pendingBytes() ?? 0),
      paused: this.ingestPaused(),
      loss: (this.pipeline?.loss ?? 0) + (this.writer?.loss ?? 0),
      ringBytes: this.ring.byteSize(),
    };
  }

  append(ev: LogIngest): LogRecord | undefined {
    if (!shouldFoldProcessLine(ev)) {
      this.flushPending();
      return this.commitIngest(ev);
    }
    let last: LogRecord | undefined;
    for (const folded of this.assembler.push(ev, Date.now(), this.serviceLogs.get(ev.service)?.multiline)) {
      last = this.commitFolded(folded);
    }
    this.scheduleIdleFlush();
    return last;
  }

  async flush(): Promise<void> {
    this.drainPipeline();
    this.flushPending();
    this.batcher?.flush();
    await this.writer?.flush();
  }

  setMemoryBudget(maxBytes: number): void {
    this.ring.setMaxBytes(maxBytes);
  }

  persistenceLoss(): number {
    return this.writer?.loss ?? 0;
  }

  persistencePaused(): boolean {
    return this.writer?.paused === true;
  }

  private parseLine(line: string): ParsedLog {
    let out: ParsedLog = parseLogLine(line);
    for (const parser of this.parsers) {
      try {
        const result = parser.parse(line);
        if (result) {
          out = { ...out, ...result };
        }
      } catch {
        // a misbehaving plugin parser must not break log ingestion
      }
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    await this.flush();
    this.writeManifest(true);
    await this.writer?.close();
  }

  query(filter: LogFilter): LogRecord[] {
    this.flushPending();
    const matches = createLogMatcher(filter);
    const out: LogRecord[] = [];
    this.forEachEvent((event) => {
      if (matches(event)) {
        out.push(event);
      }
    });
    return out;
  }

  queryPage(filter: LogFilter, page: LogPageRequest = {}): LogPage {
    this.flushPending();
    const limit = clampLogPageSize(page.limit);
    const requested = page.cursor ? decodeLogCursor(page.cursor) : undefined;
    const sessionChanged = requested !== undefined && requested.session !== this.sessionID;
    const cursor = sessionChanged ? undefined : requested;
    const direction: LogPageDirection = cursor ? (page.direction ?? "backward") : "backward";

    const matches = this.collectMatches(createLogMatcher(filter));

    let windowed: LogRecord[];
    if (!cursor) {
      windowed = matches.slice(Math.max(0, matches.length - limit));
    } else if (direction === "forward") {
      windowed = matches.filter((ev) => ev.seq > cursor.seq).slice(0, limit);
    } else {
      const before = matches.filter((ev) => ev.seq < cursor.seq);
      windowed = before.slice(Math.max(0, before.length - limit));
    }

    const firstSeq = windowed[0]?.seq;
    const lastSeq = windowed[windowed.length - 1]?.seq;
    const hasPrev = firstSeq !== undefined && matches.some((ev) => ev.seq < firstSeq);
    const hasNext = lastSeq !== undefined && matches.some((ev) => ev.seq > lastSeq);

    return {
      events: windowed,
      prevCursor: encodeLogCursor({ session: this.sessionID, seq: firstSeq ?? cursor?.seq ?? 0 }),
      nextCursor: encodeLogCursor({ session: this.sessionID, seq: lastSeq ?? cursor?.seq ?? this.nextSeq - 1 }),
      hasNext,
      hasPrev,
      sessionChanged,
    };
  }

  queryFacets(filter: LogFilter): LogFacets {
    this.flushPending();
    const withoutServices = withoutFilterDimension(filter, "services");
    const withoutLevel = withoutFilterDimension(filter, "level");
    const withoutSource = withoutFilterDimension(filter, "source");
    const search = createSearchMatcher(filter);
    let total = 0;
    const byService: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    this.forEachEvent((ev) => {
      if (!search(ev)) {
        return;
      }
      if (matchesLogDimensions(filter, ev)) {
        total += 1;
      }
      if (matchesLogDimensions(withoutServices, ev)) {
        byService[ev.service] = (byService[ev.service] ?? 0) + 1;
      }
      if (matchesLogDimensions(withoutLevel, ev)) {
        byLevel[ev.severityText] = (byLevel[ev.severityText] ?? 0) + 1;
      }
      if (matchesLogDimensions(withoutSource, ev)) {
        bySource[ev.source] = (bySource[ev.source] ?? 0) + 1;
      }
    });
    return { total, byService, byLevel, bySource };
  }

  snapshot(): LogSnapshot {
    return {
      total: this.ring.length,
      errors: this.ring.errors,
      counts: { ...this.ring.counts },
      seen: this.recorded,
      seenErrors: this.errorCount,
    };
  }

  private forEachEvent(visit: (event: LogRecord) => void): void {
    this.ring.forEach(visit);
  }

  exportTo(path: string, filter: LogFilter): void {
    const events = this.query(filter);
    writeLogExport(path, filter.dedupeRequestId === true ? dedupeLogsByRequestId(events) : events);
  }

  private commitFolded(folded: FoldedLog): LogRecord | undefined {
    const ev: LogIngest = { ...folded.ingest };
    if (folded.severityNumber !== SeverityUnspecified && ev.severityNumber === undefined) {
      ev.severityNumber = folded.severityNumber;
    }
    return this.commitIngest(ev, folded.arrivedMs);
  }

  private commitIngest(ev: LogIngest, arrivedMs = Date.now()): LogRecord | undefined {
    const skipParse = ev.body !== undefined || ev.source === "otlp";
    const line = truncateLogLine(ev.message ?? (typeof ev.body === "string" ? ev.body : ""));
    const parsed = skipParse ? ingestAsParsed(ev) : this.parseLine(line);
    const built = buildLogRecord(ev, parsed, this.nextSeq);
    const redacted = this.detector ? redactLogRecord(this.detector, built) : built;
    this.expireCorrelate(Date.now());
    const next = this.attachProxyRequestId(redacted, arrivedMs);
    if (this.shouldDropAccessDuplicate(ev, next)) {
      return undefined;
    }
    if (this.serviceLogs.get(ev.service)?.dedupe_access_line === true) {
      this.rememberAccessLine(ev.service, ev.pid, next);
    }
    this.nextSeq += 1;
    this.recorded += 1;
    if (isErrorSeverity(next.severityNumber)) {
      this.errorCount += 1;
    }
    this.pushRing(next);
    this.tagRecentServiceLogs(next, arrivedMs);
    this.rememberCorrelate(next, arrivedMs);
    this.publishRecord(next);
    return next;
  }

  private attachProxyRequestId(event: LogRecord, arrivedMs: number): LogRecord {
    if (requestIdAttribute(event) !== "") {
      return event;
    }
    for (const prev of this.recentCorrelate) {
      if (this.inCorrelateArrivalWindow(prev.arrivedMs, arrivedMs) && shouldTagServiceLogWithProxyHop(prev.event, event)) {
        return withRequestId(event, requestIdAttribute(prev.event));
      }
    }
    return event;
  }

  private tagRecentServiceLogs(event: LogRecord, arrivedMs: number): void {
    const requestId = requestIdAttribute(event);
    if (requestId === "") {
      return;
    }
    for (const prev of this.recentCorrelate) {
      if (this.inCorrelateArrivalWindow(prev.arrivedMs, arrivedMs) && shouldTagServiceLogWithProxyHop(event, prev.event)) {
        this.replaceRecord(prev.event.seq, withRequestId(prev.event, requestId));
      }
    }
  }

  private inCorrelateArrivalWindow(prevArrivedMs: number, arrivedMs: number): boolean {
    return Math.abs(prevArrivedMs - arrivedMs) <= PROXY_HOP_CORRELATE_WINDOW_MS;
  }

  private replaceRecord(seq: number, updated: LogRecord): void {
    this.ring.replace(seq, updated);
    this.recentCorrelate = this.recentCorrelate.map((row) =>
      row.event.seq === seq ? { event: updated, arrivedMs: row.arrivedMs } : row,
    );
    this.publishRecord(updated);
  }

  private expireCorrelate(nowMs: number): void {
    const cutoff = nowMs - PROXY_HOP_CORRELATE_WINDOW_MS;
    this.recentCorrelate = this.recentCorrelate.filter((row) => row.arrivedMs >= cutoff);
  }

  private rememberCorrelate(event: LogRecord, arrivedMs = Date.now()): void {
    this.recentCorrelate.push({ event, arrivedMs });
  }

  private pushRing(event: LogRecord): void {
    this.ring.push(event);
  }

  private publishRecord(event: LogRecord): void {
    this.bus?.publish(newEvent(LogReceived, event.service, { event, level: event.severityText }));
    this.noteBatch(event);
    this.onRecord?.(event);
    if (!this.writer) {
      return;
    }
    const text = `${JSON.stringify(event)}\n`;
    const key = safeServiceFile(event.service);
    this.writer.write(key, text);
  }

  private shouldDropAccessDuplicate(ev: LogIngest, next: LogRecord): boolean {
    if (this.serviceLogs.get(ev.service)?.dedupe_access_line !== true) {
      return false;
    }
    if (!(ev.pid > 0)) {
      return false;
    }
    const prev = this.lastByServicePid.get(accessLineKey(ev.service, ev.pid));
    return prev !== undefined && shouldDropAccessLine(prev, next);
  }

  private rememberAccessLine(service: string, pid: number, event: LogRecord): void {
    if (pid > 0) {
      this.lastByServicePid.set(accessLineKey(service, pid), event);
    }
  }

  private flushPending(): void {
    for (const folded of this.assembler.flushAll()) {
      this.commitFolded(folded);
    }
    this.clearIdleTimer();
  }

  private scheduleIdleFlush(): void {
    this.clearIdleTimer();
    const deadline = this.assembler.nextDeadlineMs();
    if (deadline === undefined) {
      return;
    }
    const delay = Math.max(0, deadline - Date.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      for (const folded of this.assembler.flushDue(Date.now())) {
        this.commitFolded(folded);
      }
      this.scheduleIdleFlush();
    }, delay);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private ensurePipeline(): IngestPipeline {
    if (this.pipeline) {
      return this.pipeline;
    }
    const dir = this.spoolDir !== "" ? this.spoolDir : join(this.persistDir !== "" ? this.persistDir : this.logRoot, `pipeline-${this.sessionID}`);
    this.pipeline = new IngestPipeline(dir, { spoolMaxBytes: this.maxSpoolBytes > 0 ? this.maxSpoolBytes : undefined });
    return this.pipeline;
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== undefined) {
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drainPipeline();
    }, PROCESS_SLICE_MS);
    this.drainTimer.unref?.();
  }

  private drainPipeline(): void {
    const pipeline = this.pipeline;
    if (pipeline === undefined) {
      return;
    }
    const more = pipeline.processSlice((line) => {
      this.append({
        timestamp: new Date(line.readAtMs).toISOString(),
        service: line.service,
        source: line.stream,
        stream: line.stream,
        level: "",
        message: line.line,
        pid: line.pid,
      });
    });
    if (more) {
      this.scheduleDrain();
    }
  }

  private noteBatch(event: LogRecord): void {
    if (this.bus === undefined) {
      return;
    }
    if (this.batcher === undefined) {
      this.batcher = new LogBatcher(this.sessionID, () => this.snapshot(), (payload) => {
        const service = payload.newest[0]?.service ?? event.service;
        this.bus?.publish(newEvent(LogBatch, service, payload));
      });
    }
    this.batcher.push(event);
  }

  private collectMatches(matchesFilter: (event: LogRecord) => boolean): LogRecord[] {
    const matches: LogRecord[] = [];
    for (const event of this.recordsInWindow()) {
      if (matchesFilter(event)) {
        matches.push(event);
      }
    }
    return matches;
  }

  private recordsInWindow(): LogRecord[] {
    const inMemory: LogRecord[] = [];
    this.forEachEvent((event) => inMemory.push(event));
    const oldest = this.ring.oldestSeq();
    const windowStart = Math.max(1, this.nextSeq - this.max);
    if (!this.persist || this.byteBudget <= 0 || oldest === undefined || oldest <= windowStart) {
      return inMemory;
    }
    const older = scanSessionBefore(this.persistDir, windowStart, oldest);
    if (older.length === 0) {
      return inMemory;
    }
    const seen = new Set(inMemory.map((event) => event.seq));
    const merged = older.filter((event) => !seen.has(event.seq));
    merged.push(...inMemory);
    merged.sort((a, b) => a.seq - b.seq);
    return merged;
  }

  private writeManifest(closed: boolean): void {
    if (!this.persist) {
      return;
    }
    const body = {
      repo: this.repoKey,
      retentionDays: this.retentionDays,
      bytes: this.writer?.sessionByteCount() ?? 0,
      closedAt: closed ? new Date().toISOString() : undefined,
    };
    writeFileSync(join(this.persistDir, "manifest.json"), `${JSON.stringify(body)}\n`, { mode: 0o600 });
  }
}

function shouldFoldProcessLine(ev: LogIngest): boolean {
  return isProcessLogSource(ev.source) && ev.body === undefined;
}

function ingestAsParsed(ev: LogIngest): ParsedLog {
  return {
    body: ev.body,
    attributes: ev.attributes,
    severityNumber: ev.severityNumber,
    severityText: ev.severityText ?? ev.level,
    traceId: ev.traceId,
    spanId: ev.spanId,
    traceFlags: ev.traceFlags,
    timeUnixNano: ev.timeUnixNano,
    observedTimeUnixNano: ev.observedTimeUnixNano,
    scope: ev.scope,
    resource: ev.resource,
    raw: ev.raw,
    message: ev.message,
    request_id: ev.request_id,
  };
}

export function inProcessLogStore(mgr: LogManager): LogStore {
  return {
    append: (event) => {
      mgr.append(event);
    },
    query: async (filter) => mgr.query(filter),
    queryPage: async (filter, page) => mgr.queryPage(filter, page),
    queryFacets: async (filter) => mgr.queryFacets(filter),
    snapshot: () => mgr.snapshot(),
    exportTo: async (path, filter) => {
      mgr.exportTo(path, filter);
    },
    setParsers: (parsers) => {
      mgr.setParsers(parsers);
    },
    setServiceLogs: (logs) => {
      mgr.setServiceLogs(logs);
    },
    setSecrets: (_extraMarkers, _extraPatterns, _redact) => {
      // The supervisor updates the same Detector instance this manager holds.
    },
    close: () => mgr.close(),
    ingestChunk: (chunk) => mgr.acceptChunk(chunk),
    ingestPaused: () => mgr.ingestPaused(),
    flush: () => mgr.flush(),
    setMemoryBudget: (bytes) => {
      mgr.setMemoryBudget(bytes);
    },
    setIngestShed: (shed) => {
      mgr.setIngestShed(shed);
    },
    pipelineStats: () => mgr.pipelineStats(),
  };
}

export function defaultExportPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(exportsDir(), `devctl-logs-${stamp}.jsonl`);
}

export function resolveExportPath(input = ""): string {
  if (input === "") {
    return defaultExportPath();
  }
  return resolveUserPath(input, process.cwd());
}

export function writeLogExport(path: string, events: LogRecord[]): void {
  ensureDir(dirname(path));
  const lines = events.map((ev) => JSON.stringify(ev));
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

export function openInFileManager(target: string): void {
  const folder = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
  ensureDir(folder);
  if (process.platform === "darwin") {
    const args = existsSync(target) && statSync(target).isFile() ? ["-R", target] : [folder];
    spawn("open", args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("explorer", [folder], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [folder], { detached: true, stdio: "ignore" }).unref();
}

export function listSessions(root = logsDir()): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((name) => name.startsWith(SESSION_PREFIX))
    .sort()
    .reverse();
}

export function isJsonlSessionDir(dir: string): boolean {
  const marker = join(dir, SESSION_FORMAT_FILE);
  if (existsSync(marker)) {
    return readFileSync(marker, "utf8").trim() === SESSION_FORMAT_JSONL;
  }
  if (!existsSync(dir)) {
    return false;
  }
  return readdirSync(dir).some((name) => name.endsWith(".jsonl"));
}

export function loadSessionEvents(sessionName: string, root = logsDir()): LogRecord[] {
  const dir = join(root, sessionName);
  if (!existsSync(dir)) {
    return [];
  }
  if (isJsonlSessionDir(dir)) {
    return loadJsonlSession(dir);
  }
  return loadLegacySession(dir);
}

/** Reads at most `maxBytes` from the end of each session file, then keeps the newest `maxRecords`. */
export function loadSessionTail(sessionName: string, root = logsDir(), maxRecords = 50_000, maxBytes = HISTORY_SCAN_BYTES): LogRecord[] {
  const dir = join(root, sessionName);
  if (!existsSync(dir)) {
    return [];
  }
  if (!isJsonlSessionDir(dir)) {
    return loadSessionEvents(sessionName, root).slice(-maxRecords);
  }
  const records: LogRecord[] = [];
  let read = 0;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".jsonl") && read < maxBytes) {
      const tail = readTail(join(dir, name), maxBytes - read);
      read += Buffer.byteLength(tail);
      for (const line of tail.split("\n")) {
        const record = line.trim() === "" ? undefined : parseStoredLogRecord(line);
        if (record) {
          records.push(record);
        }
      }
    }
  }
  records.sort((a, b) => a.seq - b.seq || a.timestamp.localeCompare(b.timestamp));
  return records.slice(-maxRecords);
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    const newline = start === 0 ? -1 : text.indexOf("\n");
    return newline < 0 ? text : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}

function loadJsonlSession(dir: string): LogRecord[] {
  const bySeq = new Map<number, LogRecord>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const text = readFileSync(join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const record = parseStoredLogRecord(line);
      if (record) {
        bySeq.set(record.seq, record);
      }
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq || a.timestamp.localeCompare(b.timestamp));
}

function loadLegacySession(dir: string): LogRecord[] {
  const events: LogRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".log")) {
      continue;
    }
    const text = readFileSync(join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const parts = line.split(" ");
      const rawMessage = parts.slice(3).join(" ");
      const structured = parseJSONLogLine(rawMessage);
      events.push(buildLogRecord(
        {
          timestamp: parts[0] ?? "",
          service: parts[1] ?? name.replace(/\.log$/, ""),
          source: "history",
          pid: 0,
          level: parts[2] ?? "INFO",
          message: rawMessage,
        },
        structured ?? { body: rawMessage, raw: rawMessage },
        0,
      ));
    }
  }
  const sorted = events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  sorted.forEach((ev, i) => {
    ev.seq = i + 1;
  });
  return sorted;
}

export function parseStoredLogRecord(line: string): LogRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!isPlainObject(value) || typeof value.service !== "string" || typeof value.seq !== "number") {
      return undefined;
    }
    return value as LogRecord;
  } catch {
    return undefined;
  }
}

export function safeServiceFile(service: string): string {
  const cleaned = service.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned === "" ? "service" : cleaned;
}

type PruneOptions = {
  maxTotalBytes?: number;
  liveDir?: string;
};

export function pruneSessions(root: string, retentionDays: number, maxSessionLogs: number, repoKey?: string, options: PruneOptions = {}): void {
  if (!existsSync(root)) {
    return;
  }
  const sessions = readdirSync(root)
    .filter((name) => name.startsWith(SESSION_PREFIX))
    .map((name) => {
      const path = join(root, name);
      const st = statSync(path);
      return { path, mtime: st.mtimeMs, repo: readSessionRepo(path) };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const cutoff = retentionDays > 0 ? Date.now() - retentionDays * 86_400_000 : 0;
  const counted = repoKey === undefined ? sessions : sessions.filter((session) => session.repo === repoKey);
  const countedPaths = new Set(counted.map((session) => session.path));
  sessions.forEach((session, index) => {
    const inCount = repoKey === undefined || countedPaths.has(session.path);
    const countIndex = repoKey === undefined ? index : counted.findIndex((row) => row.path === session.path);
    const tooOld = cutoff > 0 && session.mtime < cutoff && (repoKey === undefined || session.repo === repoKey || session.repo === "");
    const overCap = inCount && maxSessionLogs > 0 && countIndex >= maxSessionLogs;
    if ((tooOld || overCap) && session.path !== options.liveDir) {
      rmSync(session.path, { recursive: true, force: true });
    }
  });
  pruneSessionBytes(root, options.maxTotalBytes ?? 0, options.liveDir);
}

function pruneSessionBytes(root: string, maxTotalBytes: number, liveDir?: string): void {
  if (maxTotalBytes <= 0 || !existsSync(root)) {
    return;
  }
  const sessions = readdirSync(root)
    .filter((name) => name.startsWith(SESSION_PREFIX))
    .map((name) => {
      const path = join(root, name);
      return { path, mtime: statSync(path).mtimeMs, bytes: directorySize(path) };
    })
    .filter((session) => session.path !== liveDir)
    .sort((a, b) => a.mtime - b.mtime);
  let total = sessions.reduce((sum, session) => sum + session.bytes, 0);
  if (liveDir !== undefined && existsSync(liveDir)) {
    total += directorySize(liveDir);
  }
  for (const session of sessions) {
    if (total <= maxTotalBytes) {
      return;
    }
    rmSync(session.path, { recursive: true, force: true });
    total -= session.bytes;
  }
}

function directorySize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    total += st.isDirectory() ? directorySize(path) : st.size;
  }
  return total;
}

function scanSessionBefore(dir: string, windowStart: number, oldest: number): LogRecord[] {
  const started = Date.now();
  const records: LogRecord[] = [];
  let read = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const inBudget = name.endsWith(".jsonl") && read < HISTORY_SCAN_BYTES && Date.now() - started <= HISTORY_SCAN_MS;
    if (inBudget) {
    const tail = readTail(join(dir, name), HISTORY_SCAN_BYTES - read);
    read += Buffer.byteLength(tail);
    for (const line of tail.split("\n")) {
      const record = line.trim() === "" ? undefined : parseStoredLogRecord(line);
      if (record && record.seq >= windowStart && record.seq < oldest) {
        records.push(record);
      }
    }
    }
  }
  return records;
}

function readSessionRepo(dir: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const repo = (parsed as { repo?: unknown }).repo;
    return typeof repo === "string" ? repo : "";
  } catch {
    return "";
  }
}
