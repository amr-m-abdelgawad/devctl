import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogRecord } from "../../domain/logs/logs.ts";
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

/** Receives one spool segment's lines in read order. The segment is deleted once this returns. */
export type ReplaySink = (header: SpoolHeader, lines: ReplayLine[]) => void;

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
export async function replayLeftoverSpools(dirs: readonly string[], sink: ReplaySink, stopped: () => boolean): Promise<void> {
  for (const dir of dirs) {
    const spool = new OrderedSpool(dir);
    const splitter = new LineSplitter();
    let header: SpoolHeader | undefined;
    let lastReadAtMs = 0;
    while (!stopped()) {
      const segment = spool.peekNext();
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
        sink(header, lines);
      }
      spool.dropNext();
      await nextTurn();
    }
    if (stopped()) {
      return;
    }
    const rest = splitter.finish();
    if (header !== undefined && rest.length > 0) {
      sink(header, rest.map((line) => ({ service: header!.service, stream: header!.stream, pid: header!.pid, readAtMs: lastReadAtMs, line })));
    }
    spool.remove();
  }
}

/**
 * A sink that appends replayed lines to the history of the session that
 * produced them, continuing that session's own seq numbers, and marks the
 * session closed.
 */
export function sessionHistorySink(
  sessionDir: (session: string) => string,
  fileFor: (service: string) => string,
  build: (line: ReplayLine, seq: number) => LogRecord,
): ReplaySink {
  const nextSeq = new Map<string, number>();
  return (header, lines) => {
    const dir = sessionDir(header.session);
    const first = !nextSeq.has(dir);
    let seq = nextSeq.get(dir) ?? lastSessionSeq(dir) + 1;
    const byFile = new Map<string, string[]>();
    for (const line of lines) {
      const record = build(line, seq);
      seq += 1;
      const file = fileFor(record.service);
      const rows = byFile.get(file) ?? [];
      rows.push(`${JSON.stringify(record)}\n`);
      byFile.set(file, rows);
    }
    nextSeq.set(dir, seq);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (first) {
      markSessionClosed(dir);
    }
    for (const [file, rows] of byFile) {
      appendFileSync(join(dir, file), rows.join(""), { mode: 0o600 });
    }
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
