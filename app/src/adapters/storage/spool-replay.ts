import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogRecord } from "../../domain/logs/logs.ts";
import { SessionLogWriter } from "./log-persist.ts";
import { LineSplitter } from "./ingest/line-splitter.ts";
import { OrderedSpool, type SpoolHeader } from "./ingest/spool.ts";

// Enough of each file's end to find the last seq a session wrote.
const SEQ_SCAN_BYTES = 64 * 1024;

export type ReplayLine = {
  service: string;
  stream: string;
  pid: number;
  readAtMs: number;
  line: string;
};

/** Receives one spool segment's lines in read order. The segment is deleted once this settles. */
export type ReplaySink = (header: SpoolHeader, lines: ReplayLine[]) => void | Promise<void>;

/**
 * Stream directories an earlier daemon's pipeline left in the spool root.
 * Taken before this daemon's pipeline creates directories of its own.
 */
export function leftoverSpoolDirs(spoolRoot: string): string[] {
  if (spoolRoot === "") {
    return [];
  }
  try {
    return readdirSync(spoolRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(spoolRoot, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Replays leftover stream spools oldest segment first, yielding between
 * segments. A segment is deleted only after the sink has taken its lines, so
 * a daemon that dies mid-replay leaves the rest for the next one. A stream's
 * last partial line (the writer died mid-line) is replayed as a line.
 */
export async function replayLeftoverSpools(
  dirs: readonly string[],
  sink: ReplaySink,
  stopped: () => boolean,
  onRemaining: (bytes: number) => void = () => undefined,
): Promise<void> {
  // What is still to replay sits on disk and counts against the spool budget until it is parsed.
  const spools = dirs.map((dir) => new OrderedSpool(dir));
  let remaining = spools.reduce((sum, spool) => sum + spool.size(), 0);
  onRemaining(remaining);
  for (const spool of spools) {
    const splitter = new LineSplitter();
    let header: SpoolHeader | undefined;
    let lastReadAtMs = 0;
    while (!stopped()) {
      const segment = await spool.read();
      if (segment === undefined) {
        break;
      }
      header = segment.header ?? header;
      const lines: ReplayLine[] = [];
      for (const frame of segment.frames) {
        lastReadAtMs = frame.readAtMs;
        for (const line of splitter.push(frame.bytes)) {
          lines.push({ service: header?.service ?? "", stream: header?.stream ?? "", pid: header?.pid ?? 0, readAtMs: frame.readAtMs, line });
        }
      }
      if (header !== undefined && lines.length > 0) {
        await sink(header, lines);
      }
      await spool.drop();
      remaining = Math.max(0, remaining - segment.bytes);
      onRemaining(remaining);
      await nextTurn();
    }
    if (stopped()) {
      return;
    }
    const rest = splitter.finish();
    if (header !== undefined && rest.length > 0) {
      await sink(header, rest.map((line) => ({ service: header!.service, stream: header!.stream, pid: header!.pid, readAtMs: lastReadAtMs, line })));
    }
    await spool.destroy();
  }
  onRemaining(0);
}

export type SessionHistorySink = {
  sink: ReplaySink;
  /** Settles once every replayed line is written and each session's files are closed. */
  close(): Promise<void>;
};

export type SessionHistoryLimits = {
  /** Each dead session's cap, as its own daemon had it. */
  maxSessionBytes?: number;
  pendingLimitBytes?: number;
};

/**
 * A sink that appends replayed lines to the history of the session that
 * produced them, continuing that session's own seq numbers, and marks the
 * session closed. Lines go through the session writer, so the session keeps
 * its byte cap (its oldest parts go first), new parts, and their indexes.
 * A spool holds raw output, and each line grows several times over as a
 * stored record, so a replay written without the cap outgrows it many times.
 */
export function sessionHistorySink(
  sessionDir: (session: string) => string,
  keyFor: (service: string) => string,
  build: (line: ReplayLine, seq: number) => LogRecord,
  limits: SessionHistoryLimits = {},
): SessionHistorySink {
  const sessions = new Map<string, { writer: SessionLogWriter; nextSeq: number }>();
  const open = (dir: string): { writer: SessionLogWriter; nextSeq: number } => {
    const existing = sessions.get(dir);
    if (existing !== undefined) {
      return existing;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    markSessionClosed(dir);
    const nextSeq = lastSessionSeq(dir) + 1;
    const created = { writer: new SessionLogWriter(dir, limits.pendingLimitBytes, { maxSessionBytes: limits.maxSessionBytes }), nextSeq };
    sessions.set(dir, created);
    return created;
  };
  return {
    sink: async (header, lines) => {
      const session = open(sessionDir(header.session));
      for (const line of lines) {
        const seq = session.nextSeq;
        session.nextSeq += 1;
        const record = build(line, seq);
        session.writer.write(keyFor(record.service), `${JSON.stringify(record)}\n`, seq);
      }
      if (session.writer.backpressured()) {
        await session.writer.flush();
      }
    },
    close: async () => {
      await Promise.all([...sessions.values()].map((session) => session.writer.close()));
      sessions.clear();
    },
  };
}

function lastSessionSeq(dir: string): number {
  let last = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    for (const line of tailText(join(dir, name)).split("\n")) {
      const match = /"seq":(\d+)/.exec(line);
      if (match !== null) {
        last = Math.max(last, Number(match[1]));
      }
    }
  }
  return last;
}

function tailText(path: string): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - SEQ_SCAN_BYTES);
    fd = openSync(path, "r");
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

// The daemon that owned the session is gone; the pruner may treat it as closed.
function markSessionClosed(dir: string): void {
  const path = join(dir, "manifest.json");
  let manifest: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        manifest = parsed as Record<string, unknown>;
      }
    } catch {
      manifest = {};
    }
  }
  if (typeof manifest.closedAt === "string") {
    return;
  }
  try {
    writeFileSync(path, `${JSON.stringify({ ...manifest, closedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch {
    // an unwritable manifest only delays pruning
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
