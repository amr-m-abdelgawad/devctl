import { existsSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOG_CAP_BYTES } from "../../domain/logs/budgets.ts";
import type { ProcessChunkHandler } from "../../ports/process-runtime.ts";
import { OrderedSpool, type SpoolFrame, type SpoolHeader } from "../storage/ingest/spool.ts";
import { fifoChunks, sleepMs } from "./fifo-reader.ts";
import { deliverEnd } from "./output-pump.ts";

// A stream's frames go to disk as one segment once they reach this size, and
// every FLUSH_MS in any case, so a killed drainer loses little.
const SEGMENT_BYTES = 256 * 1024;
const FLUSH_MS = 250;
const RETRY_MS = 5;
const SPOOL_SESSION = "drain";

export type DrainStream = { fd: number; service: string; stream: "stdout" | "stderr"; pid: number };

export type DrainPlan = {
  /** One 0600 spool for every stream; the next daemon replays it and deletes each segment it delivers. */
  spoolDir: string;
  /** Reading stops once the spool and the frames waiting for it reach this. */
  maxBytes: number;
  /**
   * The dead daemon's own spool of unparsed output. What it still holds counts
   * against `maxBytes` too, so both together stay within the one cap.
   */
  ingestSpoolDir?: string;
  /** Written after the last flush, so the next daemon knows the spool is complete. */
  stoppedPath: string;
  streams: DrainStream[];
};

export type Drain = {
  stop(): void;
  done: Promise<void>;
};

type Pending = {
  header: SpoolHeader;
  frames: SpoolFrame[];
  bytes: number;
  lastReadAtMs: number;
};

/**
 * Reads every service FIFO while no daemon runs. Output goes into one spool
 * with the time it was read. An empty frame marks a stream that ended. Once
 * the spool is full the drainer stops reading, so services block on write
 * instead of losing output or dying. `stop()` ends reading, writes what was
 * read, and settles `done`; so does the end of every stream.
 */
export function startDrain(plan: DrainPlan): Drain {
  const spool = new OrderedSpool(plan.spoolDir);
  const pending: Pending[] = plan.streams.map((s) => ({
    header: { session: SPOOL_SESSION, service: s.service, stream: s.stream, pid: s.pid },
    frames: [],
    bytes: 0,
    lastReadAtMs: 0,
  }));
  let stopping = false;
  let blocked = false;
  let wake = (): void => undefined;
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const flush = (entry: Pending): void => {
    if (entry.frames.length === 0) {
      return;
    }
    if (spool.append(entry.header, entry.frames) !== "ok") {
      // Out of disk: keep the frames and stop reading until the next daemon takes over.
      blocked = true;
      return;
    }
    entry.frames = [];
    entry.bytes = 0;
  };
  // Nothing reads the dead daemon's spool while no daemon runs, so its size is fixed.
  const budget = plan.maxBytes - (plan.ingestSpoolDir === undefined ? 0 : directoryBytes(plan.ingestSpoolDir));
  const full = (): boolean => blocked || spool.size() + pending.reduce((sum, entry) => sum + entry.bytes, 0) >= budget;
  const timer = setInterval(() => {
    for (const entry of pending) {
      flush(entry);
    }
  }, FLUSH_MS);
  const pumps = plan.streams.map(async (source, index) => {
    const entry = pending[index]!;
    for await (const chunk of fifoChunks(source.fd, () => stopping)) {
      entry.lastReadAtMs = Math.max(entry.lastReadAtMs, Date.now());
      entry.frames.push({ readAtMs: entry.lastReadAtMs, bytes: Buffer.from(chunk) });
      entry.bytes += chunk.byteLength;
      if (entry.bytes >= SEGMENT_BYTES) {
        flush(entry);
      }
      if (full()) {
        await stopped;
      }
    }
    entry.frames.push({ readAtMs: entry.lastReadAtMs || Date.now(), bytes: Buffer.alloc(0) });
    flush(entry);
  });
  const done = Promise.race([Promise.all(pumps), stopped]).then(() => {
    clearInterval(timer);
    for (const entry of pending) {
      flush(entry);
    }
    writeFileSync(plan.stoppedPath, `${process.pid}\n`, { mode: 0o600 });
  });
  return {
    stop: () => {
      stopping = true;
      wake();
    },
    done,
  };
}

/** Entry for `devctl _drain <plan>`: the sentinel execs it once its daemon is gone. */
export async function runDrainCommand(arg: string): Promise<void> {
  // Before the first read: a SIGTERM that arrived later would otherwise kill
  // the drainer with output it read but never wrote.
  let drain: Drain | undefined;
  let stopEarly = false;
  process.on("SIGTERM", () => {
    stopEarly = true;
    drain?.stop();
  });
  const plan = parseDrainPlan(arg);
  if (plan === undefined) {
    return;
  }
  drain = startDrain(plan);
  if (stopEarly) {
    drain.stop();
  }
  await drain.done;
}

/** How the sentinel starts the drainer: the compiled binary, or Bun running this module from source. */
export function drainCommand(plan: DrainPlan): string[] {
  const arg = JSON.stringify(plan);
  if (Bun.isStandaloneExecutable === true) {
    return [process.execPath, "_drain", arg];
  }
  const mod = fileURLToPath(new URL("./fifo-drain.ts", import.meta.url));
  return [
    process.execPath,
    "-e",
    `import { runDrainCommand } from ${JSON.stringify(mod)}; await runDrainCommand(process.argv[1] ?? ""); process.exit(0);`,
    arg,
  ];
}

function parseDrainPlan(arg: string): DrainPlan | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(arg);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const plan = raw as Partial<DrainPlan>;
  if (typeof plan.spoolDir !== "string" || plan.spoolDir === "" || typeof plan.stoppedPath !== "string" || !Array.isArray(plan.streams)) {
    return undefined;
  }
  const maxBytes = typeof plan.maxBytes === "number" && plan.maxBytes > 0 ? plan.maxBytes : DEFAULT_LOG_CAP_BYTES;
  const streams = plan.streams.filter((s): s is DrainStream =>
    typeof s === "object" && s !== null && Number.isInteger(s.fd) && s.fd >= 3 && typeof s.service === "string"
    && (s.stream === "stdout" || s.stream === "stderr") && Number.isInteger(s.pid));
  const ingestSpoolDir = typeof plan.ingestSpoolDir === "string" && plan.ingestSpoolDir !== "" ? plan.ingestSpoolDir : undefined;
  return { spoolDir: plan.spoolDir, maxBytes, ingestSpoolDir, stoppedPath: plan.stoppedPath, streams };
}

function directoryBytes(dir: string): number {
  let total = 0;
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(path);
    } else {
      try {
        total += statSync(path).size;
      } catch {
        // removed meanwhile
      }
    }
  }
  return total;
}

/**
 * Hands the drain spool, oldest segment first, to the handler for each
 * segment's service and pid, with the time each chunk was read. A segment is
 * deleted once all of it is delivered; a refused chunk is offered again.
 */
export async function replayDrained(
  spoolDir: string,
  handlerFor: (service: string, pid: number) => ProcessChunkHandler | undefined,
  onRemaining: (bytes: number) => void = () => undefined,
): Promise<void> {
  if (!existsSync(spoolDir)) {
    return;
  }
  const spool = new OrderedSpool(spoolDir);
  // What is left here is unparsed output on disk: it shares the spool budget until it is delivered.
  onRemaining(spool.size());
  // Reads and deletes go through the thread pool: this runs on the daemon's thread.
  for (let segment = await spool.read(); segment !== undefined; segment = await spool.read()) {
    const header = segment.header;
    const handler = header === undefined ? undefined : handlerFor(header.service, header.pid);
    if (header !== undefined && handler !== undefined) {
      const stream = header.stream === "stderr" ? "stderr" : "stdout";
      for (const frame of segment.frames) {
        if (frame.bytes.byteLength === 0) {
          await deliverEnd(stream, handler);
        } else {
          await offer(handler, stream, frame.bytes, { pid: header.pid, readAtMs: frame.readAtMs, replayed: true });
        }
      }
    }
    await spool.drop();
    onRemaining(spool.size());
    await nextTurn();
  }
  onRemaining(0);
}

async function offer(handler: ProcessChunkHandler, stream: "stdout" | "stderr", bytes: Uint8Array, meta: { pid: number; readAtMs: number; replayed: true }): Promise<void> {
  while (handler(stream, bytes, meta) === false) {
    await sleepMs(RETRY_MS);
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
