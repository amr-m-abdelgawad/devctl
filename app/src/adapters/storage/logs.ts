import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Bus, LogReceived, newEvent } from "../../shared/events.ts";
import { type Detector } from "../secrets/detector.ts";
import type { LogSnapshot, LogStore } from "../../ports/log-store.ts";
import { ensureDir, exportsDir, logsDir, resolveUserPath } from "./storage.ts";
import { LogRing } from "./log-ring.ts";
import { SessionLogWriter } from "./log-persist.ts";
import { HISTORY_SCAN_BYTES } from "../../domain/logs/budgets.ts";

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
    this.ring = new LogRing(this.max, options.maxMemoryBytes ?? 0);
    this.bus = bus;
    this.detector = detector;
    this.sessionID = sessionID;
    const root = directory === "" || directory.startsWith("~/") ? logsDir() : directory;
    this.persist = persist && sessionID !== "";
    this.persistDir = this.persist ? join(root, `${SESSION_PREFIX}${sessionID}`) : "";
    if (this.persist) {
      mkdirSync(this.persistDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.persistDir, SESSION_FORMAT_FILE), `${SESSION_FORMAT_JSONL}\n`, { mode: 0o600 });
      writeFileSync(join(this.persistDir, "manifest.json"), `${JSON.stringify({ repo: options.repoKey ?? "", retentionDays, bytes: 0 })}\n`, { mode: 0o600 });
      this.writer = new SessionLogWriter(this.persistDir, options.pendingLimitBytes);
      pruneSessions(root, retentionDays, maxSessionLogs, options.repoKey);
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
    this.flushPending();
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
    await this.flush();
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

    const matchesFilter = createLogMatcher(filter);
    const matches: LogRecord[] = [];
    this.forEachEvent((event) => {
      if (matchesFilter(event)) {
        matches.push(event);
      }
    });

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
    ingestPaused: () => mgr.persistencePaused(),
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

export function pruneSessions(root: string, retentionDays: number, maxSessionLogs: number, repoKey?: string): void {
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
    if (tooOld || overCap) {
      rmSync(session.path, { recursive: true, force: true });
    }
  });
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
