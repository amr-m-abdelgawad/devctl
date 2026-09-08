import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Bus, LogReceived, newEvent } from "../../shared/events.ts";
import { type Detector } from "../secrets/detector.ts";
import type { LogStore } from "../../ports/log-store.ts";
import { ensureDir, exportsDir, logsDir } from "./storage.ts";

import { LevelError, LevelFatal, type LogEvent, type LogParser, parseJSONLogLine, type LogFilter, parseLevel, parseRequestID, matchLog, type LogPageDirection, type LogPageRequest, type LogPage, type LogFacets, clampLogPageSize, truncateLogLine } from "../../domain/logs/logs.ts";
export * from "../../domain/logs/logs.ts";

const DEFAULT_MAX_EVENTS = 50_000;
const SESSION_PREFIX = "session-";


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

function withoutFilterDimension(filter: LogFilter, dimension: "services" | "level" | "source"): LogFilter {
  const copy = { ...filter };
  copy[dimension] = undefined;
  return copy;
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

  append(ev: Omit<LogEvent, "seq">): LogEvent {
    const message = truncateLogLine(ev.message);
    const parsed = this.parseLine(message);
    const redact = (text: string) => (this.detector ? this.detector.redactText(text) : text);
    const structured = parsed.raw !== undefined;
    const rawText = redact(message);
    const extracted = parsed.message !== undefined ? redact(truncateLogLine(parsed.message)) : undefined;
    const next: LogEvent = {
      ...ev,
      timestamp: ev.timestamp || new Date().toISOString(),
      level: ev.level || parsed.level || parseLevel(message),
      request_id: ev.request_id || parsed.request_id || parseRequestID(message),
      message: structured && extracted !== undefined ? extracted : rawText,
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
    return next;
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
    setSecrets: (_extraMarkers, _extraPatterns) => {
      // The supervisor updates the same Detector instance this manager holds.
    },
    close: () => mgr.close(),
  };
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
