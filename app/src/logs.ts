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
const MAX_LOG_REGEX_REPEAT = 64;
const NESTED_QUANTIFIER = /\((?:[^)\\]|\\.)*([+*?]|\{)(?:[^)\\]|\\.)*\)[+*?{]/;

export function compileLogSearch(pattern: string): RegExp | undefined {
  if (pattern.length === 0 || pattern.length > MAX_LOG_SEARCH_REGEX || unsafeLogRegex(pattern)) {
    return undefined;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function unsafeLogRegex(pattern: string): boolean {
  if (quantifierCount(pattern) > MAX_LOG_REGEX_QUANTIFIERS) {
    return true;
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return true;
  }
  return oversizedRepeat(pattern);
}

function quantifierCount(pattern: string): number {
  let count = 0;
  let escaped = false;
  for (const ch of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
      count += 1;
    }
  }
  return count;
}

function oversizedRepeat(pattern: string): boolean {
  for (const match of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    const start = Number(match[1]);
    const rawEnd = match[2];
    const end = rawEnd === undefined || rawEnd === "" ? start : Number(rawEnd);
    if (start > MAX_LOG_REGEX_REPEAT || end > MAX_LOG_REGEX_REPEAT) {
      return true;
    }
  }
  return false;
}

const DEFAULT_MAX_EVENTS = 50_000;
const SESSION_PREFIX = "session-";

export class LogManager {
  private events: LogEvent[] = [];
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
    this.events.push(next);
    if (this.events.length > this.max) {
      this.events = this.events.slice(this.events.length - this.max);
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
    return this.events.filter((ev) => matchLog(filter, ev));
  }

  snapshot(): { total: number; errors: number; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    let errors = 0;
    for (const ev of this.events) {
      counts[ev.service] = (counts[ev.service] ?? 0) + 1;
      if (ev.level === LevelError || ev.level === LevelFatal) {
        errors += 1;
      }
    }
    return { total: this.events.length, errors, counts };
  }

  clear(): void {
    this.events = [];
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
