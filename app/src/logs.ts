import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Bus } from "./events.ts";
import { LogReceived, newEvent } from "./events.ts";
import { type Detector } from "./secrets.ts";
import { ensureDir, exportsDir, logsDir } from "./storage.ts";

export const LevelTrace = "TRACE";
export const LevelDebug = "DEBUG";
export const LevelInfo = "INFO";
export const LevelWarn = "WARN";
export const LevelError = "ERROR";
export const LevelFatal = "FATAL";
export const LevelUnknown = "UNKNOWN";

export type LogLevel =
  | typeof LevelTrace
  | typeof LevelDebug
  | typeof LevelInfo
  | typeof LevelWarn
  | typeof LevelError
  | typeof LevelFatal
  | typeof LevelUnknown
  | string;

const LEVEL_ORDER: Record<string, number> = {
  [LevelTrace]: 0,
  [LevelDebug]: 1,
  [LevelInfo]: 2,
  [LevelWarn]: 3,
  [LevelError]: 4,
  [LevelFatal]: 5,
  [LevelUnknown]: 2,
};

export type LogEvent = {
  timestamp: string;
  service: string;
  source: string;
  level: LogLevel;
  message: string;
  pid: number;
  stream?: string;
  request_id?: string;
  identity?: string;
  // Original line, set only when `message` was extracted from a structured
  // (JSON-per-line) log — lets the details view show the full payload even
  // though the list shows just the human-readable message.
  raw?: string;
  // Assigned by LogManager.append(), monotonically increasing within one
  // daemon session (never reused, never reassigned on ring-buffer eviction).
  // Cursor-based pagination pages by this instead of by timestamp, since
  // multiple events can share a millisecond but never a sequence number.
  seq: number;
};

export type LogParser = {
  name: string;
  parse: (line: string) => Partial<LogEvent> | undefined;
};

export function defaultLogParser(): LogParser {
  return {
    name: "default",
    parse: (line) => {
      const structured = parseJSONLogLine(line);
      if (structured) {
        return structured;
      }
      return {
        level: parseLevel(line),
        request_id: parseRequestID(line) || undefined,
      };
    },
  };
}

// Structured loggers (pino, bunyan, zap, logrus, and similar) emit one JSON
// object per line; devctl otherwise shows that whole object as the message.
const JSON_MESSAGE_KEYS = ["message", "msg", "text", "log", "event"];
const JSON_LEVEL_KEYS = ["level", "severity", "levelname", "loglevel", "lvl"];
const JSON_REQUEST_ID_KEYS = ["request_id", "requestId", "trace_id", "traceId", "correlation_id", "correlationId"];

// pino's numeric level convention.
const NUMERIC_LEVELS: Record<number, LogLevel> = {
  10: LevelTrace,
  20: LevelDebug,
  30: LevelInfo,
  40: LevelWarn,
  50: LevelError,
  60: LevelFatal,
};

function firstStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function jsonLogLevel(obj: Record<string, unknown>): LogLevel | undefined {
  for (const key of JSON_LEVEL_KEYS) {
    const value = obj[key];
    if (typeof value === "number") {
      const named = NUMERIC_LEVELS[value];
      if (named) {
        return named;
      }
      continue;
    }
    if (typeof value === "string" && value.trim() !== "") {
      return value.toUpperCase();
    }
  }
  return undefined;
}

export function parseJSONLogLine(line: string): Partial<LogEvent> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const message = firstStringField(obj, JSON_MESSAGE_KEYS);
  const level = jsonLogLevel(obj);
  const requestId = firstStringField(obj, JSON_REQUEST_ID_KEYS);
  if (message === undefined && level === undefined && requestId === undefined) {
    return undefined;
  }
  return { message: message ?? trimmed, level, request_id: requestId, raw: trimmed };
}

export type LogFilter = {
  services?: string[];
  level?: string;
  source?: string;
  search?: string;
  regex?: boolean;
  since?: string;
  until?: string;
};

const REQUEST_ID_RE = /(?:x-devctl-request-id|request[_-]?id)[=: ]+([A-Za-z0-9-]+)/i;
const LEVEL_PATTERNS: Array<{ re: RegExp; level: LogLevel }> = [
  { re: /\b(fatal|critical)\b/i, level: LevelFatal },
  { re: /\b(error|err)\b/i, level: LevelError },
  { re: /\b(warn|warning)\b/i, level: LevelWarn },
  { re: /\b(debug|dbg)\b/i, level: LevelDebug },
  { re: /\b(trace)\b/i, level: LevelTrace },
  { re: /\b(info|information)\b/i, level: LevelInfo },
];

export function parseLevel(line: string): LogLevel {
  const found = LEVEL_PATTERNS.find((p) => p.re.test(line));
  return found?.level ?? LevelUnknown;
}

export function parseRequestID(line: string): string {
  const match = REQUEST_ID_RE.exec(line);
  return match?.[1] ?? "";
}

export function matchLog(filter: LogFilter, ev: LogEvent): boolean {
  if (filter.services && filter.services.length > 0 && !filter.services.includes(ev.service)) {
    return false;
  }
  if (filter.level && (LEVEL_ORDER[ev.level] ?? 2) < (LEVEL_ORDER[filter.level] ?? 2)) {
    return false;
  }
  if (filter.source && ev.source !== filter.source) {
    return false;
  }
  if (filter.since && ev.timestamp < filter.since) {
    return false;
  }
  if (filter.until && ev.timestamp > filter.until) {
    return false;
  }
  if (!filter.search) {
    return true;
  }
  if (filter.regex) {
    const re = compileLogSearch(filter.search);
    if (re) {
      return re.test(ev.message) || (ev.raw !== undefined && re.test(ev.raw));
    }
  }
  const needle = filter.search.toLowerCase();
  return ev.message.toLowerCase().includes(needle) || (ev.raw !== undefined && ev.raw.toLowerCase().includes(needle));
}

const MAX_LOG_SEARCH_REGEX = 200;
const MAX_LOG_REGEX_QUANTIFIERS = 8;
const MAX_LOG_REGEX_DEPTH = 2;

type RegexAtom = "none" | "atom" | "quantified-group" | "quant";

type RegexParser = {
  readonly raw: string;
  i: number;
  readonly out: string[];
  quantifiers: number;
  depth: number;
  lastAtom: RegexAtom;
  readonly groupQuant: boolean[];
};

export function compileLogSearch(pattern: string): RegExp | undefined {
  const source = rewriteLogRegex(pattern);
  if (source === undefined) {
    return undefined;
  }
  return new RegExp(source);
}

function rewriteLogRegex(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_LOG_SEARCH_REGEX) {
    return undefined;
  }
  const parser: RegexParser = {
    raw,
    i: 0,
    out: [],
    quantifiers: 0,
    depth: 0,
    lastAtom: "none",
    groupQuant: [],
  };
  if (!parseRegexBody(parser) || parser.i !== raw.length || parser.depth !== 0) {
    return undefined;
  }
  return parser.out.join("");
}

function parseRegexBody(parser: RegexParser): boolean {
  while (parser.i < parser.raw.length) {
    if (parser.raw[parser.i] === ")") {
      return true;
    }
    if (!parseRegexPart(parser)) {
      return false;
    }
  }
  return true;
}

function parseRegexPart(parser: RegexParser): boolean {
  const ch = parser.raw[parser.i] ?? "";
  if (ch === "|") {
    return emitOp(parser, "|", "none");
  }
  if (ch === "^") {
    return emitOp(parser, "^", "none");
  }
  if (ch === "$") {
    return emitOp(parser, "$", "none");
  }
  if (ch === ".") {
    return emitOp(parser, ".", "atom");
  }
  if (ch === "(") {
    return parseGroup(parser);
  }
  if (ch === "[") {
    return parseClass(parser);
  }
  if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
    return parseQuantifier(parser);
  }
  if (ch === "\\") {
    return parseEscape(parser);
  }
  parser.out.push(RegExp.escape(ch));
  parser.i += 1;
  parser.lastAtom = "atom";
  return true;
}

function emitOp(parser: RegexParser, op: string, atom: RegexAtom): boolean {
  parser.out.push(op);
  parser.i += 1;
  parser.lastAtom = atom;
  return true;
}

function parseGroup(parser: RegexParser): boolean {
  parser.i += 1;
  parser.depth += 1;
  if (parser.depth > MAX_LOG_REGEX_DEPTH) {
    return false;
  }
  parser.groupQuant.push(false);
  parser.out.push("(?:");
  if (!parseRegexBody(parser) || parser.raw[parser.i] !== ")") {
    return false;
  }
  parser.out.push(")");
  parser.i += 1;
  parser.depth -= 1;
  const innerQuant = parser.groupQuant.pop() === true;
  parser.lastAtom = innerQuant ? "quantified-group" : "atom";
  return true;
}

function parseQuantifier(parser: RegexParser): boolean {
  const ch = parser.raw[parser.i] ?? "";
  if (ch === "{" || parser.lastAtom === "none" || parser.lastAtom === "quant" || parser.lastAtom === "quantified-group") {
    return false;
  }
  if (parser.quantifiers >= MAX_LOG_REGEX_QUANTIFIERS) {
    return false;
  }
  if (ch === "*") {
    parser.out.push("*");
  } else if (ch === "+") {
    parser.out.push("+");
  } else if (ch === "?") {
    parser.out.push("?");
  } else {
    return false;
  }
  parser.i += 1;
  parser.quantifiers += 1;
  const parent = parser.groupQuant.length - 1;
  if (parent >= 0) {
    parser.groupQuant[parent] = true;
  }
  if (parser.raw[parser.i] === "?") {
    parser.out.push("?");
    parser.i += 1;
  }
  parser.lastAtom = "quant";
  return true;
}

function parseClass(parser: RegexParser): boolean {
  parser.i += 1;
  parser.out.push("[");
  if (parser.raw[parser.i] === "^") {
    parser.out.push("^");
    parser.i += 1;
  }
  if (parser.raw[parser.i] === "]") {
    parser.out.push(RegExp.escape("]"));
    parser.i += 1;
  }
  while (parser.i < parser.raw.length && parser.raw[parser.i] !== "]") {
    const ch = parser.raw[parser.i] ?? "";
    if (ch === "\\") {
      if (!parseEscape(parser)) {
        return false;
      }
    } else if (ch === "-") {
      parser.out.push("-");
      parser.i += 1;
    } else {
      parser.out.push(RegExp.escape(ch));
      parser.i += 1;
    }
  }
  if (parser.raw[parser.i] !== "]") {
    return false;
  }
  parser.out.push("]");
  parser.i += 1;
  parser.lastAtom = "atom";
  return true;
}

function parseEscape(parser: RegexParser): boolean {
  const next = parser.raw[parser.i + 1];
  if (next === undefined) {
    return false;
  }
  if (next === "d") {
    parser.out.push("\\d");
  } else if (next === "D") {
    parser.out.push("\\D");
  } else if (next === "w") {
    parser.out.push("\\w");
  } else if (next === "W") {
    parser.out.push("\\W");
  } else if (next === "s") {
    parser.out.push("\\s");
  } else if (next === "S") {
    parser.out.push("\\S");
  } else if (next === "n") {
    parser.out.push("\\n");
  } else if (next === "t") {
    parser.out.push("\\t");
  } else if (next === "r") {
    parser.out.push("\\r");
  } else if (next === "b") {
    parser.out.push("\\b");
  } else if (next === "B") {
    parser.out.push("\\B");
  } else {
    parser.out.push(RegExp.escape(next));
  }
  parser.i += 2;
  parser.lastAtom = "atom";
  return true;
}

const DEFAULT_MAX_EVENTS = 50_000;
const SESSION_PREFIX = "session-";

export const DEFAULT_LOG_PAGE_SIZE = 500;
export const MAX_LOG_PAGE_SIZE = 5_000;

type LogCursor = { session: string; seq: number };

// Opaque to callers: they carry a cursor from one page's nextCursor/prevCursor
// straight into the next request without inspecting it. Encoding it (rather
// than exposing the raw session+seq pair) keeps that contract enforceable —
// a client can't construct or mutate a cursor into pointing somewhere the
// server didn't hand it.
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

export type LogPageDirection = "forward" | "backward";

export type LogPageRequest = {
  cursor?: string;
  // "backward" (the default when a cursor is given) pages toward older
  // events; "forward" pages toward newer ones. Irrelevant with no cursor —
  // that always returns the latest page.
  direction?: LogPageDirection;
  limit?: number;
};

export type LogPage = {
  // Always in ascending sequence (chronological) order, regardless of
  // paging direction.
  events: LogEvent[];
  nextCursor: string;
  prevCursor: string;
  hasNext: boolean;
  hasPrev: boolean;
  // True when a cursor was given but named a prior daemon session (a
  // restart happened since it was issued); the cursor is then ignored and
  // this page is the latest one, same as no cursor at all.
  sessionChanged: boolean;
};

export type LogFacets = {
  // Every active filter applied, exactly like query()'s own result count.
  total: number;
  // Each of these applies every *other* active filter but not its own
  // dimension — byService, for instance, still respects the current level/
  // source/search/since/until filters, just not a services filter, so it
  // answers "how many would match per service under my other filters" for
  // a service-picker UI to show without the user first clearing anything.
  byService: Record<string, number>;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
};

function withoutFilterDimension(filter: LogFilter, dimension: "services" | "level" | "source"): LogFilter {
  const copy = { ...filter };
  copy[dimension] = undefined;
  return copy;
}

export function clampLogPageSize(limit?: number): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return DEFAULT_LOG_PAGE_SIZE;
  }
  return Math.min(limit as number, MAX_LOG_PAGE_SIZE);
}

export class LogManager {
  private events: LogEvent[] = [];
  private eventStart = 0;
  private nextSeq = 1;
  private readonly max: number;
  private readonly bus?: Bus;
  private readonly detector?: Detector;
  private readonly persistDir: string;
  private readonly persist: boolean;
  private readonly sessionID: string;
  private readonly streams = new Map<string, WriteStream>();
  private readonly lastWrite = new Map<string, Promise<void>>();
  private parsers: LogParser[] = [];

  constructor(
    max: number,
    bus: Bus | undefined,
    detector: Detector | undefined,
    persist: boolean,
    directory: string,
    sessionID: string,
    retentionDays = 0,
    maxSessionLogs = 0,
  ) {
    this.max = max > 0 ? max : DEFAULT_MAX_EVENTS;
    this.bus = bus;
    this.detector = detector;
    this.sessionID = sessionID;
    const root = directory === "" || directory.startsWith("~/") ? logsDir() : directory;
    this.persist = persist && sessionID !== "";
    this.persistDir = this.persist ? join(root, `${SESSION_PREFIX}${sessionID}`) : "";
    if (this.persist) {
      mkdirSync(this.persistDir, { recursive: true, mode: 0o700 });
      pruneSessions(root, retentionDays, maxSessionLogs);
    }
  }

  sessionDir(): string {
    return this.persistDir;
  }

  // Plugin log parsers are loaded asynchronously after this manager is
  // constructed (loadPluginPaths runs after the Supervisor wires up
  // logging), so they're pushed in here rather than taken as a constructor
  // argument.
  setParsers(parsers: LogParser[]): void {
    this.parsers = parsers;
  }

  append(ev: Omit<LogEvent, "seq">): void {
    const parsed = this.parseLine(ev.message);
    const redact = (text: string) => (this.detector ? this.detector.redactText(text) : text);
    const structured = parsed.raw !== undefined;
    const rawText = redact(ev.message);
    const next: LogEvent = {
      ...ev,
      timestamp: ev.timestamp || new Date().toISOString(),
      level: ev.level || parsed.level || parseLevel(ev.message),
      request_id: ev.request_id || parsed.request_id || parseRequestID(ev.message),
      message: structured && parsed.message !== undefined ? redact(parsed.message) : rawText,
      raw: structured ? rawText : undefined,
      seq: this.nextSeq++,
    };
    if (this.events.length < this.max) {
      this.events.push(next);
    } else {
      this.events[this.eventStart] = next;
      this.eventStart = (this.eventStart + 1) % this.max;
    }
    this.bus?.publish(newEvent(LogReceived, next.service, { event: next, level: next.level }));
    if (this.persist) {
      const line = `${next.timestamp} ${next.service} ${next.level} ${next.raw ?? next.message}\n`;
      const key = safeServiceFile(next.service);
      const stream = this.streamFor(key);
      // fs.WriteStream.write() queues the write asynchronously instead of
      // blocking the event loop the way appendFileSync() does; writes to a
      // given stream are still delivered in order, so tracking only the
      // most recent one is enough for flush() to know everything queued
      // before it has landed.
      this.lastWrite.set(
        key,
        new Promise((resolve) => {
          stream.write(line, () => resolve());
        }),
      );
    }
  }

  // Waits for all writes queued so far to land on disk. Persistence is
  // asynchronous during normal operation; call this where code needs the
  // on-disk file to be current (tests, and close()).
  async flush(): Promise<void> {
    await Promise.all([...this.lastWrite.values()]);
  }

  private parseLine(line: string): Partial<LogEvent> {
    let out: Partial<LogEvent> = {};
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

  private streamFor(key: string): WriteStream {
    let stream = this.streams.get(key);
    if (stream === undefined) {
      stream = createWriteStream(join(this.persistDir, `${key}.log`), { flags: "a", mode: 0o600 });
      // A write stream with no error listener crashes the process on error
      // (e.g. disk full, file removed underneath us); we have no better
      // channel to report it from inside the logger itself, so drop it.
      stream.on("error", () => {});
      this.streams.set(key, stream);
    }
    return stream;
  }

  // Flushes pending writes and releases the per-service file handles kept
  // open by append(). Call on supervisor shutdown.
  async close(): Promise<void> {
    await this.flush();
    await Promise.all(
      [...this.streams.values()].map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.end(() => resolve());
          }),
      ),
    );
    this.streams.clear();
    this.lastWrite.clear();
  }

  query(filter: LogFilter): LogEvent[] {
    const out: LogEvent[] = [];
    this.forEachEvent((event) => {
      if (matchLog(filter, event)) {
        out.push(event);
      }
    });
    return out;
  }

  // Bounded, cursor-paged counterpart to query() — query() itself stays
  // unbounded on purpose (export, and anything else that legitimately wants
  // every matching event, must not be silently truncated by a page size).
  queryPage(filter: LogFilter, page: LogPageRequest = {}): LogPage {
    const limit = clampLogPageSize(page.limit);
    const requested = page.cursor ? decodeLogCursor(page.cursor) : undefined;
    const sessionChanged = requested !== undefined && requested.session !== this.sessionID;
    const cursor = sessionChanged ? undefined : requested;
    const direction: LogPageDirection = cursor ? (page.direction ?? "backward") : "backward";

    const matches: LogEvent[] = [];
    this.forEachEvent((event) => {
      if (matchLog(filter, event)) {
        matches.push(event);
      }
    });

    let windowed: LogEvent[];
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

  // Lightweight on purpose: no event payload, just counts, so a client
  // following logs can poll this every couple of seconds for live facet
  // counts without re-fetching (and re-transferring) the page it already
  // has.
  queryFacets(filter: LogFilter): LogFacets {
    const withoutServices = withoutFilterDimension(filter, "services");
    const withoutLevel = withoutFilterDimension(filter, "level");
    const withoutSource = withoutFilterDimension(filter, "source");
    let total = 0;
    const byService: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    this.forEachEvent((ev) => {
      if (matchLog(filter, ev)) {
        total += 1;
      }
      if (matchLog(withoutServices, ev)) {
        byService[ev.service] = (byService[ev.service] ?? 0) + 1;
      }
      if (matchLog(withoutLevel, ev)) {
        byLevel[ev.level] = (byLevel[ev.level] ?? 0) + 1;
      }
      if (matchLog(withoutSource, ev)) {
        bySource[ev.source] = (bySource[ev.source] ?? 0) + 1;
      }
    });
    return { total, byService, byLevel, bySource };
  }

  snapshot(): { total: number; errors: number; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    let errors = 0;
    this.forEachEvent((ev) => {
      counts[ev.service] = (counts[ev.service] ?? 0) + 1;
      if (ev.level === LevelError || ev.level === LevelFatal) {
        errors += 1;
      }
    });
    return { total: this.events.length, errors, counts };
  }

  private forEachEvent(visit: (event: LogEvent) => void): void {
    const count = this.events.length;
    for (let offset = 0; offset < count; offset += 1) {
      const event = this.events[(this.eventStart + offset) % count];
      if (event) {
        visit(event);
      }
    }
  }

  exportTo(path: string, filter: LogFilter): void {
    writeLogExport(path, this.query(filter));
  }
}

export function defaultExportPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(exportsDir(), `devctl-logs-${stamp}.log`);
}

export function resolveExportPath(input = ""): string {
  if (input === "") {
    return defaultExportPath();
  }
  const expanded = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export function writeLogExport(path: string, events: LogEvent[]): void {
  ensureDir(dirname(path));
  const lines = events.map((ev) => `${ev.timestamp} ${ev.service} ${ev.level} ${ev.raw ?? ev.message}`);
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

export function loadSessionEvents(sessionName: string, root = logsDir()): LogEvent[] {
  const dir = join(root, sessionName);
  if (!existsSync(dir)) {
    return [];
  }
  const events: LogEvent[] = [];
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
      events.push({
        timestamp: parts[0] ?? "",
        service: parts[1] ?? name.replace(/\.log$/, ""),
        source: "history",
        level: parts[2] ?? "INFO",
        message: structured?.message ?? rawMessage,
        raw: structured ? rawMessage : undefined,
        pid: 0,
        // A past session's own sequence numbers aren't recoverable from the
        // persisted text format, and these are a read-only historical view,
        // never paginated against the live session — index order after the
        // chronological sort below is a fine, locally-consistent stand-in.
        seq: 0,
      });
    }
  }
  const sorted = events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  sorted.forEach((ev, i) => {
    ev.seq = i + 1;
  });
  return sorted;
}

export function safeServiceFile(service: string): string {
  const cleaned = service.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned === "" ? "service" : cleaned;
}

export function pruneSessions(root: string, retentionDays: number, maxSessionLogs: number): void {
  if (!existsSync(root)) {
    return;
  }
  const sessions = readdirSync(root)
    .filter((name) => name.startsWith(SESSION_PREFIX))
    .map((name) => {
      const path = join(root, name);
      const st = statSync(path);
      return { path, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const cutoff = retentionDays > 0 ? Date.now() - retentionDays * 86_400_000 : 0;
  sessions.forEach((session, index) => {
    const tooOld = cutoff > 0 && session.mtime < cutoff;
    const overCap = maxSessionLogs > 0 && index >= maxSessionLogs;
    if (tooOld || overCap) {
      rmSync(session.path, { recursive: true, force: true });
    }
  });
}
