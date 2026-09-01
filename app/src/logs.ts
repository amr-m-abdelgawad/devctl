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
};

export type LogParser = {
  name: string;
  parse: (line: string) => Partial<LogEvent> | undefined;
};

export function defaultLogParser(): LogParser {
  return {
    name: "default",
    parse: (line) => ({
      level: parseLevel(line),
      request_id: parseRequestID(line) || undefined,
    }),
  };
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
      return re.test(ev.message);
    }
  }
  return ev.message.toLowerCase().includes(filter.search.toLowerCase());
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

export class LogManager {
  private events: LogEvent[] = [];
  private eventStart = 0;
  private readonly max: number;
  private readonly bus?: Bus;
  private readonly detector?: Detector;
  private readonly persistDir: string;
  private readonly persist: boolean;
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

  append(ev: LogEvent): void {
    const parsed = this.parseLine(ev.message);
    const next: LogEvent = {
      ...ev,
      timestamp: ev.timestamp || new Date().toISOString(),
      level: ev.level || parsed.level || parseLevel(ev.message),
      request_id: ev.request_id || parsed.request_id || parseRequestID(ev.message),
      message: this.detector ? this.detector.redactText(ev.message) : ev.message,
    };
    if (this.events.length < this.max) {
      this.events.push(next);
    } else {
      this.events[this.eventStart] = next;
      this.eventStart = (this.eventStart + 1) % this.max;
    }
    this.bus?.publish(newEvent(LogReceived, next.service, { event: next, level: next.level }));
    if (this.persist) {
      const line = `${next.timestamp} ${next.service} ${next.level} ${next.message}\n`;
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

  clear(): void {
    this.events = [];
    this.eventStart = 0;
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
  const lines = events.map((ev) => `${ev.timestamp} ${ev.service} ${ev.level} ${ev.message}`);
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
      events.push({
        timestamp: parts[0] ?? "",
        service: parts[1] ?? name.replace(/\.log$/, ""),
        source: "history",
        level: parts[2] ?? "INFO",
        message: parts.slice(3).join(" "),
        pid: 0,
      });
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
