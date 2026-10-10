import { closeSync, constants, openSync, readdirSync, readSync, unlinkSync, watch, writeSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

const READ_BYTES = 64 * 1024;
// One wakeup reads at most this much before yielding, so a busy FIFO cannot
// hold the event loop. macOS hands back at most 8 KiB per read.
const BATCH_BYTES = 256 * 1024;
const IDLE_FIRST_MS = 1;
const IDLE_MAX_MS = 100;
// A FIFO quiet for this long is watched instead of polled, where a watch reports writes.
const WATCH_AFTER_MS = 8;
// After this many sweeps in a row found output its watch did not report, a stream is polled again.
const WATCH_MISSES = 3;
const PROBE_WAIT_MS = 200;
const PROBE_PREFIX = ".watch-probe-";

/**
 * Lets an idle reader sleep instead of polling. The owner sets `path` to the
 * FIFO's path where a watch on it reports writes (see `probeFifoWatch`); the
 * reader clears it for a stream whose watch turns out not to. `kick` is set
 * while the reader sleeps and makes it read at once: the owner calls it when
 * the writing process exits, since a watch does not report a close.
 */
export type FifoWake = {
  path?: string;
  kick?: () => void;
};

type Batch = Uint8Array | "eof" | undefined;

/** `batch` is what the sweep read for the sleeper; `watch` says how its watch did. */
type Woken = { batch: Batch; watch?: "fired" | "missed" | "failed" };

/**
 * Output from the non-blocking read end of a service FIFO, pulled with
 * explicit reads. Bun's FIFO streams stall under backpressure on macOS and
 * cannot stop without losing what they read ahead, and blocking reads park a
 * pool thread per stream. Here nothing is read until the consumer pulls, so
 * a consumer that stops pulling stops the writer. An empty FIFO is retried
 * with a short backoff, and a reader that stays idle goes to sleep: one
 * timer for all sleeping readers checks their FIFOs every 100 ms. Where a
 * watch reports writes the reader sleeps after 8 ms already, and the write
 * itself wakes it. Once `stopped()` is true the next pull never settles:
 * unread output stays in the FIFO for the next reader, and the consumer does
 * not mistake the handoff for the end of the stream. EOF, when every writer
 * has closed, ends the iteration. `fd` must stay open until the iteration
 * has ended or `stopped()` is true: a sleeping reader's FIFO is read by
 * descriptor number.
 */
export async function* fifoChunks(fd: number, stopped: () => boolean = () => false, wake: FifoWake = {}): AsyncGenerator<Uint8Array> {
  const buf = Buffer.allocUnsafe(READ_BYTES);
  let idleMs = IDLE_FIRST_MS;
  let misses = 0;
  for (;;) {
    if (stopped()) {
      await never();
    }
    let batch = readBatch(fd, buf, BATCH_BYTES);
    if (batch === undefined && (idleMs >= IDLE_MAX_MS || (idleMs >= WATCH_AFTER_MS && wake.path !== undefined))) {
      const woken = await asleep(fd, buf, stopped, wake);
      if (woken.watch === "fired") {
        misses = 0;
      } else if (woken.watch === "missed") {
        misses += 1;
      }
      if (woken.watch === "failed" || misses >= WATCH_MISSES) {
        wake.path = undefined;
      }
      if (woken.batch === undefined) {
        continue;
      }
      batch = woken.batch;
    }
    if (batch === "eof") {
      return;
    }
    if (batch !== undefined) {
      idleMs = IDLE_FIRST_MS;
      yield batch;
      continue;
    }
    await sleepMs(idleMs);
    idleMs = Math.min(idleMs * 2, IDLE_MAX_MS);
  }
}

// Reads until the FIFO is empty or `maxBytes` are read. Undefined means
// nothing is available yet; bytes read before EOF are returned first, and
// the next call sees the EOF again.
function readBatch(fd: number, buf: Buffer, maxBytes: number): Batch {
  const parts: Buffer[] = [];
  let total = 0;
  while (total < maxBytes) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        break;
      }
      return total > 0 ? Buffer.concat(parts, total) : "eof";
    }
    if (n === 0) {
      return total > 0 ? Buffer.concat(parts, total) : "eof";
    }
    parts.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  return total > 0 ? Buffer.concat(parts, total) : undefined;
}

// Every sleeping reader's check of its FIFO. One timer runs them all, so an
// idle stream costs one empty read per sweep and no timer or wakeup of its own.
const sleepers = new Set<() => void>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function sweep(): void {
  for (const check of sleepers) {
    check();
  }
}

/**
 * Sleeps until the FIFO has output, its last writer closed it, the reader is
 * kicked, or it is stopped. The sweep finds all of those within 100 ms, as
 * polling did. A watch on `wake.path` lasts for this one sleep and ends it
 * at the write: a watcher kept across sleeps misses writes, and one left
 * open while the FIFO is busy costs a callback per write.
 */
function asleep(fd: number, buf: Buffer, stopped: () => boolean, wake: FifoWake): Promise<Woken> {
  return new Promise<Woken>((resolve) => {
    let watcher: FSWatcher | undefined;
    let awake = false;
    const wakeUp = (woken: Woken): void => {
      if (awake) {
        return;
      }
      awake = true;
      sleepers.delete(check);
      if (sleepers.size === 0) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      wake.kick = undefined;
      closeWatcher(watcher);
      resolve(woken);
    };
    const check = (): void => {
      if (stopped()) {
        wakeUp({ batch: undefined });
        return;
      }
      // One read's worth: the reader takes the rest itself once it is awake.
      const batch = readBatch(fd, buf, READ_BYTES);
      if (batch !== undefined) {
        wakeUp({ batch, watch: watcher !== undefined && batch !== "eof" ? "missed" : undefined });
      }
    };
    if (wake.path !== undefined) {
      try {
        watcher = watch(wake.path, () => wakeUp({ batch: undefined, watch: "fired" }));
        watcher.on("error", () => wakeUp({ batch: undefined, watch: "failed" }));
      } catch {
        // The path is gone, or the watch limit is used up.
        resolve({ batch: undefined, watch: "failed" });
        return;
      }
      // A write between the empty read and the watch is not reported.
      const batch = readBatch(fd, buf, BATCH_BYTES);
      if (batch !== undefined) {
        closeWatcher(watcher);
        resolve({ batch });
        return;
      }
    }
    sleepers.add(check);
    sweepTimer ??= setInterval(sweep, IDLE_MAX_MS);
    wake.kick = () => wakeUp({ batch: undefined });
  });
}

function closeWatcher(watcher: FSWatcher | undefined): void {
  try {
    watcher?.close();
  } catch {
    // already closed
  }
}

/**
 * Whether a watch on a FIFO in `dir` reports a write to it. Linux reports it
 * within a fraction of a millisecond, and does not open the FIFO to watch
 * it. macOS reports nothing for a FIFO, and a network or FUSE mount may not
 * either. It is tested once with a scratch FIFO, so readers only sleep on a
 * watch where one is known to wake them.
 */
export async function probeFifoWatch(dir: string): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  const path = join(dir, `${PROBE_PREFIX}${process.pid}`);
  let reader: number | undefined;
  let writer: number | undefined;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    removeProbes(dir);
    const made = Bun.spawn({ cmd: ["mkfifo", "-m", "600", path], stdout: "ignore", stderr: "ignore" });
    if ((await made.exited) !== 0) {
      return false;
    }
    reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    writer = openSync(path, constants.O_RDWR);
    const fired = new Promise<boolean>((resolve) => {
      watcher = watch(path, () => resolve(true));
      watcher.on("error", () => resolve(false));
      timer = setTimeout(() => resolve(false), PROBE_WAIT_MS);
    });
    writeSync(writer, "x");
    return await fired;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    closeWatcher(watcher);
    if (reader !== undefined) {
      closeQuiet(reader);
    }
    if (writer !== undefined) {
      closeQuiet(writer);
    }
    removeProbes(dir);
  }
}

// Also the scratch FIFO of a daemon that died in the middle of its probe.
function removeProbes(dir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(PROBE_PREFIX)) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // already gone
      }
    }
  }
}

export function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}
