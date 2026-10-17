import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fifoChunks, probeFifoWatch, type FifoWake } from "./fifo-reader.ts";

const dirs: string[] = [];
const fds: number[] = [];
const kids: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const kid of kids.splice(0)) {
    kid.kill("SIGKILL");
  }
  for (const fd of fds.splice(0)) {
    try {
      closeSync(fd);
    } catch {
      // the test closed it
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devctl-fifo-reader-"));
  dirs.push(dir);
  return dir;
}

// Whether a watch reports a write to a FIFO here: on Linux, not on macOS.
const probeDir = mkdtempSync(join(tmpdir(), "devctl-fifo-probe-"));
const WATCHABLE = process.platform !== "win32" && (await probeFifoWatch(probeDir));
rmSync(probeDir, { recursive: true, force: true });

// A FIFO whose write end this test holds, so it decides when output arrives.
function heldFifo(): { fifo: string; dir: string; readFd: number; writeFd: number } {
  const dir = tempDir();
  const fifo = join(dir, "fifo");
  expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
  const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const writeFd = openSync(fifo, constants.O_RDWR);
  fds.push(readFd, writeFd);
  return { fifo, dir, readFd, writeFd };
}

// A path a watch can be put on that nothing ever writes to.
function quietFile(dir: string): string {
  const path = join(dir, "quiet");
  writeFileSync(path, "");
  return path;
}

function text(step: IteratorResult<Uint8Array>): string {
  return step.done === true ? "<end>" : Buffer.from(step.value).toString("utf8");
}

async function asleep(wake: FifoWake): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (wake.kick === undefined && Date.now() < deadline) {
    await Bun.sleep(2);
  }
  return wake.kick !== undefined;
}

// Runs microtasks only. No timer fires meanwhile, so nothing the sweep does can be seen after it.
async function microtasks(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await Promise.resolve();
  }
}

// This process's open descriptors and the inotify watches it holds (Linux).
function held(): { descriptors: number; watches: number } {
  const open = readdirSync("/proc/self/fd");
  let watches = 0;
  for (const fd of open) {
    try {
      watches += readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").split("\n").filter((line) => line.startsWith("inotify ")).length;
    } catch {
      // the descriptor readdir itself used
    }
  }
  return { descriptors: open.length, watches };
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
}

// A FIFO whose only writer is `script`, holding an O_RDWR end like a service.
function fifoWriter(script: string): { readFd: () => number; proc: ReturnType<typeof Bun.spawn> } {
  const dir = tempDir();
  const fifo = join(dir, "fifo");
  expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
  const first = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const serviceEnd = openSync(fifo, constants.O_RDWR);
  const proc = Bun.spawn({ cmd: ["/bin/sh", "-c", script], stdout: serviceEnd, stderr: "ignore" });
  closeSync(serviceEnd);
  kids.push(proc);
  let opened = false;
  return {
    proc,
    readFd: () => {
      if (!opened) {
        opened = true;
        return first;
      }
      return openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    },
  };
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) {
    text += Buffer.from(chunk).toString("utf8");
  }
  return text;
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

describe.skipIf(process.platform === "win32")("fifo reader", () => {
  test("reads what the writer wrote across an idle gap and ends when it exits", async () => {
    const { readFd } = fifoWriter("printf one; sleep 0.3; printf two");
    const fd = readFd();
    expect(await collect(fifoChunks(fd))).toBe("onetwo");
    closeSync(fd);
  });

  test("a stopped reader leaves the rest in the FIFO, and the next reader has no gap", async () => {
    const { readFd } = fifoWriter("i=1; while [ $i -le 20000 ]; do echo $i; i=$((i+1)); done");
    const firstFd = readFd();
    let stop = false;
    const first = fifoChunks(firstFd, () => stop);
    let head = "";
    while (head.length < 20_000) {
      const step = await first.next();
      head += Buffer.from(step.value ?? new Uint8Array()).toString("utf8");
    }
    stop = true;
    expect(await settlesWithin(first.next(), 300)).toBe(false);
    const nextFd = readFd();
    const rest = await collect(fifoChunks(nextFd));
    const lines = (head + rest).trimEnd().split("\n").map(Number);
    expect(lines).toEqual(Array.from({ length: 20_000 }, (_, i) => i + 1));
    closeSync(firstFd);
    closeSync(nextFd);
  });

  test("a consumer that stops pulling blocks the writer instead of buffering its output", async () => {
    const { readFd, proc } = fifoWriter("head -c 4194304 /dev/zero");
    const fd = readFd();
    const chunks = fifoChunks(fd);
    const first = await chunks.next();
    expect(first.done).toBe(false);
    await Bun.sleep(400);
    expect(proc.exitCode).toBeNull();
    let total = first.value?.byteLength ?? 0;
    for await (const chunk of chunks) {
      total += chunk.byteLength;
    }
    expect(total).toBe(4 * 1024 * 1024);
    expect(await proc.exited).toBe(0);
    closeSync(fd);
  });
});

describe.skipIf(process.platform === "win32")("fifo reader asleep", () => {
  test("a kick makes a sleeping reader read at once", async () => {
    const { readFd, writeFd } = heldFifo();
    const wake: FifoWake = {};
    const chunks = fifoChunks(readFd, () => false, wake);
    let got: string | undefined;
    void chunks.next().then((step) => {
      got = text(step);
    });
    expect(await asleep(wake)).toBe(true);
    writeSync(writeFd, "late");
    wake.kick?.();
    await microtasks();
    expect(got).toBe("late");
    expect(wake.kick).toBeUndefined();
  });

  test("the sweep hands a sleeping reader its output and the end of its stream", async () => {
    const { readFd } = fifoWriter("printf one; sleep 0.4; printf two; sleep 0.4");
    const fd = readFd();
    const wake: FifoWake = {};
    const chunks = fifoChunks(fd, () => false, wake);
    expect(text(await chunks.next())).toBe("one");
    const second = chunks.next();
    expect(await asleep(wake)).toBe(true);
    expect(text(await second)).toBe("two");
    const end = chunks.next();
    expect(await asleep(wake)).toBe(true);
    const sleptAt = Date.now();
    expect(text(await end)).toBe("<end>");
    // The writer exits within 400 ms of going quiet, and no sweep is more than 100 ms away.
    expect(Date.now() - sleptAt).toBeLessThan(900);
    closeSync(fd);
  });

  test("a reader stopped in its sleep reads nothing more, and the next reader gets it", async () => {
    const { fifo, readFd, writeFd } = heldFifo();
    let stop = false;
    const wake: FifoWake = {};
    const first = fifoChunks(readFd, () => stop, wake);
    const pending = first.next();
    expect(await asleep(wake)).toBe(true);
    stop = true;
    writeSync(writeFd, "kept");
    expect(await settlesWithin(pending, 350)).toBe(false);
    expect(wake.kick).toBeUndefined();
    const nextFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    fds.push(nextFd);
    expect(text(await fifoChunks(nextFd).next())).toBe("kept");
  });

  test("output that a watch did not report still arrives, and after three in a row the stream is polled again", async () => {
    const { dir, readFd, writeFd } = heldFifo();
    const quiet = quietFile(dir);
    const wake: FifoWake = { path: quiet };
    const chunks = fifoChunks(readFd, () => false, wake);
    for (let i = 0; i < 3; i++) {
      const next = chunks.next();
      expect(await asleep(wake)).toBe(true);
      expect(wake.path).toBe(quiet);
      const wroteAt = Date.now();
      writeSync(writeFd, `w${i}`);
      expect(text(await next)).toBe(`w${i}`);
      expect(Date.now() - wroteAt).toBeLessThan(400);
    }
    expect(wake.path).toBeUndefined();
    const next = chunks.next();
    writeSync(writeFd, "polled");
    expect(text(await next)).toBe("polled");
  });

  test("a path that cannot be watched falls back to polling and loses nothing", async () => {
    const { dir, readFd, writeFd } = heldFifo();
    const wake: FifoWake = { path: join(dir, "gone") };
    const chunks = fifoChunks(readFd, () => false, wake);
    const first = chunks.next();
    await Bun.sleep(60);
    expect(wake.path).toBeUndefined();
    writeSync(writeFd, "a");
    expect(text(await first)).toBe("a");
    const second = chunks.next();
    expect(await asleep(wake)).toBe(true);
    writeSync(writeFd, "b");
    expect(text(await second)).toBe("b");
  });
});

describe.skipIf(!WATCHABLE)("fifo reader on a watch", () => {
  test("a write wakes a sleeping reader within a few milliseconds, every time", async () => {
    const { fifo, readFd, writeFd } = heldFifo();
    const wake: FifoWake = { path: fifo };
    const chunks = fifoChunks(readFd, () => false, wake);
    const waits: number[] = [];
    for (let i = 0; i < 30; i++) {
      const next = chunks.next();
      expect(await asleep(wake)).toBe(true);
      // Anywhere in the sweep's 100 ms: only the watch is fast at every phase of it.
      await Bun.sleep(5 + (i * 37) % 90);
      const wroteAt = performance.now();
      writeSync(writeFd, `n${i}`);
      expect(text(await next)).toBe(`n${i}`);
      waits.push(performance.now() - wroteAt);
    }
    expect(median(waits)).toBeLessThan(15);
    expect(wake.path).toBe(fifo);
  });

  test("going to sleep and waking leaves no descriptor and no watch behind", async () => {
    const { fifo, readFd, writeFd } = heldFifo();
    const wake: FifoWake = { path: fifo };
    const chunks = fifoChunks(readFd, () => false, wake);
    // Watchers of one path share a watch, so a leaked one shows as a watch that outlives the sleep.
    const awake = held().watches;
    let descriptors = 0;
    for (let i = 0; i < 150; i++) {
      const next = chunks.next();
      expect(await asleep(wake)).toBe(true);
      expect(held().watches).toBe(awake + 1);
      writeSync(writeFd, "x");
      expect(text(await next)).toBe("x");
      if (i === 9) {
        // After the first sleeps: the watcher's own descriptor exists by now.
        descriptors = held().descriptors;
      }
    }
    expect(held()).toEqual({ descriptors, watches: awake });
  });

  test("output written between the empty read and the watch is read at once, and its watch is closed", async () => {
    const { fifo, readFd, writeFd } = heldFifo();
    const quiet = held().watches;
    let wroteAt = 0;
    // The reader asks for the path once its read came back empty, just before it arms the watch.
    const wake: FifoWake = {
      get path() {
        if (wroteAt === 0) {
          wroteAt = performance.now();
          writeSync(writeFd, "raced");
        }
        return fifo;
      },
    };
    const step = await fifoChunks(readFd, () => false, wake).next();
    expect(text(step)).toBe("raced");
    // The watch saw nothing of this write: asleep, the reader would get it from a sweep 100 ms later.
    expect(performance.now() - wroteAt).toBeLessThan(60);
    expect(wake.kick).toBeUndefined();
    expect(held().watches).toBe(quiet);
  });

  // The reader arms a watch right after an empty read. If the last writer
  // exits in between, the FIFO has none: a runtime that opened the FIFO to
  // watch it would block there for good.
  test("a watch on a FIFO that nobody holds for writing returns at once", async () => {
    const dir = tempDir();
    const fifo = join(dir, "fifo");
    expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
    const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    fds.push(readFd);
    const watcher = watch(fifo, () => undefined);
    watcher.close();
    expect(text(await fifoChunks(readFd, () => false, { path: fifo }).next())).toBe("<end>");
  });

  test("the probe leaves no scratch FIFO behind, not even one a dead daemon left", async () => {
    const dir = tempDir();
    expect(spawnSync("mkfifo", ["-m", "600", join(dir, ".watch-probe-1")]).status).toBe(0);
    expect(await probeFifoWatch(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

test.skipIf(process.platform === "linux" || process.platform === "win32")("where no watch reports a FIFO write, the probe says so without making anything", async () => {
  const dir = tempDir();
  expect(await probeFifoWatch(dir)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
});
