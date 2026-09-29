import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, readSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOG_CAP_BYTES } from "../../domain/logs/budgets.ts";
import type { ProcessChunkHandler } from "../../ports/process-runtime.ts";
import { OrderedSpool, type SpoolFrame, type SpoolHeader } from "../storage/ingest/spool.ts";
import { directoryBytes, ensureStdioDir, FIFO_SEGMENT_BYTES, readyPath, segmentPath } from "./fifo-segments.ts";
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
  const full = (): boolean => blocked || spool.size() + pending.reduce((sum, entry) => sum + entry.bytes, 0) >= plan.maxBytes;
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
  return { spoolDir: plan.spoolDir, maxBytes, stoppedPath: plan.stoppedPath, streams };
}

/**
 * Hands the drain spool, oldest segment first, to the handler for each
 * segment's service and pid, with the time each chunk was read. A segment is
 * deleted once all of it is delivered; a refused chunk is offered again.
 */
export async function replayDrained(
  spoolDir: string,
  handlerFor: (service: string, pid: number) => ProcessChunkHandler | undefined,
): Promise<void> {
  if (!existsSync(spoolDir)) {
    return;
  }
  const spool = new OrderedSpool(spoolDir);
  for (let segment = spool.peekNext(); segment !== undefined; segment = spool.peekNext()) {
    const header = segment.header;
    const handler = header === undefined ? undefined : handlerFor(header.service, header.pid);
    if (header !== undefined && handler !== undefined) {
      const stream = header.stream === "stderr" ? "stderr" : "stdout";
      for (const frame of segment.frames) {
        if (frame.bytes.byteLength === 0) {
          await deliverEnd(stream, handler);
        } else {
          await offer(handler, stream, frame.bytes, { pid: header.pid, readAtMs: frame.readAtMs });
        }
      }
    }
    spool.dropNext();
    await nextTurn();
  }
}

async function offer(handler: ProcessChunkHandler, stream: "stdout" | "stderr", bytes: Uint8Array, meta: { pid: number; readAtMs: number }): Promise<void> {
  while (handler(stream, bytes, meta) === false) {
    await sleepMs(RETRY_MS);
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// The per-stream drainer below is replaced by startDrain and goes away with its callers.
const READ_BYTES = 64 * 1024;
const IDLE_MS = 5;

/**
 * Holds the read end of a service FIFO and rotates raw output into 0600
 * segments. The daemon consumes completed segments, so a restart does not
 * close the only reader and SIGPIPE the service.
 */
export async function runFifoDrain(fifoPath: string, dir: string, maxBytes = DEFAULT_LOG_CAP_BYTES): Promise<void> {
  if (fifoPath === "" || dir === "") {
    return;
  }
  ensureStdioDir(dir);
  writeFileSync(join(dir, "reader"), `${process.pid}\n`, { mode: 0o600 });
  const readFd = await openReader(fifoPath);
  let seq = 0;
  let fd = openSegment(dir, seq);
  let filled = 0;
  const buf = Buffer.alloc(READ_BYTES);
  try {
    while (true) {
      if (directoryBytes(dir) >= maxBytes) {
        await sleepMs(IDLE_MS);
        continue;
      }
      const read = readOnce(readFd, buf);
      if (read === "wait") {
        if (filled > 0) {
          const rotated = rotate(dir, fd, seq);
          fd = rotated.fd;
          seq = rotated.seq;
          filled = 0;
        }
        await sleepMs(IDLE_MS);
        continue;
      }
      if (read === "eof") {
        if (filled > 0) {
          rotate(dir, fd, seq);
        }
        return;
      }
      writeSync(fd, buf, 0, read);
      filled += read;
      if (filled >= FIFO_SEGMENT_BYTES) {
        const rotated = rotate(dir, fd, seq);
        fd = rotated.fd;
        seq = rotated.seq;
        filled = 0;
      }
    }
  } finally {
    closeQuiet(readFd);
    closeQuiet(fd);
  }
}

function openSegment(dir: string, seq: number): number {
  return openSync(segmentPath(dir, seq), "a", 0o600);
}

function rotate(dir: string, fd: number, seq: number): { fd: number; seq: number } {
  closeQuiet(fd);
  writeFileSync(readyPath(dir, seq), "", { mode: 0o600 });
  const next = seq + 1;
  return { fd: openSegment(dir, next), seq: next };
}

function readOnce(fd: number, buf: Buffer): number | "wait" | "eof" {
  try {
    const n = readSync(fd, buf, 0, buf.length, null);
    return n <= 0 ? "eof" : n;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") {
      return "wait";
    }
    return "eof";
  }
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

export function ensureFifo(path: string): void {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const created = spawnSync("mkfifo", ["-m", "600", path], { timeout: 1_000 });
  if (created.status !== 0 && !existsSync(path)) {
    throw new Error(`mkfifo failed for ${path}`);
  }
}

async function openReader(fifoPath: string): Promise<number> {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
  for (;;) {
    try {
      return openSync(fifoPath, flags);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENXIO") {
        throw err;
      }
      await sleepMs(IDLE_MS);
    }
  }
}
