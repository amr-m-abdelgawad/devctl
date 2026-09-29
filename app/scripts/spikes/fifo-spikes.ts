#!/usr/bin/env bun
/**
 * Gating spikes for FIFO service stdio. Not part of devctl; nothing imports this.
 *
 *   bun scripts/spikes/fifo-spikes.ts s3   Does a Bun reader stop reading when JS stops pulling?
 *   bun scripts/spikes/fifo-spikes.ts s5   O_RDWR FIFO semantics for the service's write end.
 *
 * Linux: docker run --rm --memory 2g -v "$PWD/scripts/spikes:/spikes" -w /spikes oven/bun:1.4.2 bun fifo-spikes.ts s3
 * Recorded output is in fifo-spikes.results.txt.
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, createReadStream, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SELF = import.meta.path;
const CHUNK = 64 * 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const S3_RUN_MS = 6_000;
const S3_CONSUMER_SLEEP_MS = 20;
const NONBLOCK_READ = constants.O_RDONLY | constants.O_NONBLOCK;

type Progress = { bytes: number; eagain: number; error: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function mkfifo(path: string): void {
  const made = spawnSync("mkfifo", ["-m", "600", path]);
  if (made.status !== 0) {
    throw new Error(`mkfifo ${path} failed`);
  }
}

function readProgress(path: string): Progress {
  try {
    return JSON.parse(readFileSync(path, "utf8").trim()) as Progress;
  } catch {
    return { bytes: 0, eagain: 0, error: "" };
  }
}

// Word i of the stream holds i (big-endian u64), so a reader can prove it saw no gap.
function fillPattern(buf: Buffer, offset: number): void {
  const first = offset / 8;
  for (let i = 0; i < buf.length / 8; i += 1) {
    const word = first + i;
    buf.writeUInt32BE(Math.floor(word / 2 ** 32), i * 8);
    buf.writeUInt32BE(word >>> 0, i * 8 + 4);
  }
}

function wordAt(buf: Buffer, at: number): number {
  return buf.readUInt32BE(at) * 2 ** 32 + buf.readUInt32BE(at + 4);
}

/** Writes `total` bytes to fd 1 as fast as blocking writes allow, recording progress after every write. */
function writer(progressPath: string, total: number, pattern: boolean): void {
  const progress = openSync(progressPath, "w", 0o600);
  const buf = Buffer.alloc(CHUNK, 0x61);
  const state: Progress = { bytes: 0, eagain: 0, error: "" };
  const report = (): void => {
    writeSync(progress, JSON.stringify(state).padEnd(120), 0);
  };
  while (state.bytes < total) {
    if (pattern) {
      fillPattern(buf, state.bytes);
    }
    let off = 0;
    while (off < buf.length) {
      try {
        off += writeSync(1, buf, off, buf.length - off);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? String(err);
        if (code === "EAGAIN") {
          state.eagain += 1;
          report();
          pause(1);
          continue;
        }
        state.error = code;
        report();
        process.exit(3);
      }
    }
    state.bytes += buf.length;
    report();
  }
}

type ReaderSummary = { firstOffset: number; endOffset: number; bytes: number; ok: boolean; eof: boolean };

/** Reads the pattern from a FIFO until `stopPath` exists, checking every word follows the one before. */
async function reader(fifo: string, outPath: string, stopPath: string): Promise<void> {
  const fd = openSync(fifo, NONBLOCK_READ);
  const buf = Buffer.alloc(CHUNK);
  const summary: ReaderSummary = { firstOffset: -1, endOffset: -1, bytes: 0, ok: true, eof: false };
  let carry = Buffer.alloc(0);
  let expected = -1;
  const save = (): void => writeFileSync(outPath, JSON.stringify(summary));
  save();
  while (!existsSync(stopPath)) {
    let n = 0;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
        await sleep(2);
        continue;
      }
      throw err;
    }
    if (n === 0) {
      summary.eof = true;
      break;
    }
    let data = Buffer.concat([carry, buf.subarray(0, n)]);
    if (expected < 0) {
      const skew = alignment(data);
      if (skew < 0) {
        carry = data;
        summary.bytes += n;
        continue;
      }
      expected = wordAt(data, skew);
      summary.firstOffset = expected * 8 - skew;
      data = data.subarray(skew);
    }
    const words = Math.floor(data.length / 8);
    for (let i = 0; i < words; i += 1) {
      if (wordAt(data, i * 8) !== expected) {
        summary.ok = false;
      }
      expected += 1;
    }
    carry = Buffer.from(data.subarray(words * 8));
    summary.bytes += n;
    summary.endOffset = summary.firstOffset + summary.bytes;
    save();
  }
  save();
  closeSync(fd);
}

// Offset (0-7) where three consecutive words count up by one; -1 until enough bytes arrive.
function alignment(data: Buffer): number {
  for (let skew = 0; skew < 8 && skew + 24 <= data.length; skew += 1) {
    const a = wordAt(data, skew);
    if (wordAt(data, skew + 8) === a + 1 && wordAt(data, skew + 16) === a + 2) {
      return skew;
    }
  }
  return -1;
}

async function* readLoop(fd: number): AsyncGenerator<Uint8Array> {
  const buf = Buffer.alloc(CHUNK);
  for (;;) {
    let n = 0;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
        await sleep(5);
        continue;
      }
      throw err;
    }
    if (n === 0) {
      return;
    }
    yield Buffer.from(buf.subarray(0, n));
  }
}

function fifoSource(mode: string, fifo: string): AsyncIterable<Uint8Array> {
  switch (mode) {
    case "fifo-bunfile-path":
      return Bun.file(fifo).stream();
    case "fifo-bunfile-fd":
      return Bun.file(openSync(fifo, NONBLOCK_READ)).stream();
    case "fifo-node-stream":
      return createReadStream(fifo);
    case "fifo-node-stream-fd":
      return createReadStream("", { fd: openSync(fifo, constants.O_RDONLY) });
    case "fifo-net-socket":
      return new Socket({ fd: openSync(fifo, NONBLOCK_READ), readable: true, writable: false });
    case "fifo-read-loop":
      return readLoop(openSync(fifo, NONBLOCK_READ));
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

type Sample = { ms: number; rssMiB: number; consumedMiB: number; writtenMiB: number };

/** One S3 consumer: a writer floods ~1 GiB while this process sleeps between chunks. */
async function consume(mode: string, dir: string): Promise<void> {
  const progress = join(dir, "progress");
  const cmd = [process.execPath, SELF, "writer", progress, String(GIB), "flat"];
  let child: ReturnType<typeof Bun.spawn>;
  let source: AsyncIterable<Uint8Array>;
  if (mode === "spawn-pipe") {
    const piped = Bun.spawn({ cmd, stdout: "pipe", stderr: "inherit" });
    child = piped;
    source = piped.stdout;
  } else {
    const fifo = join(dir, "fifo");
    mkfifo(fifo);
    const serviceEnd = openSync(fifo, constants.O_RDWR);
    child = Bun.spawn({ cmd, stdout: serviceEnd, stderr: "inherit" });
    closeSync(serviceEnd);
    source = fifoSource(mode, fifo);
  }
  const started = Date.now();
  const samples: Sample[] = [];
  let consumed = 0;
  let maxChunk = 0;
  let endedAtMs = -1;
  const sample = (): void => {
    samples.push({
      ms: Date.now() - started,
      rssMiB: Math.round(process.memoryUsage().rss / MIB),
      consumedMiB: Math.round((consumed / MIB) * 10) / 10,
      writtenMiB: Math.round((readProgress(progress).bytes / MIB) * 10) / 10,
    });
  };
  const timer = setInterval(sample, 1_000);
  setTimeout(() => {
    clearInterval(timer);
    sample();
    const eagain = readProgress(progress).eagain;
    child.kill("SIGKILL");
    process.stdout.write(`${JSON.stringify({ mode, maxChunkKiB: Math.round(maxChunk / 1024), writerEagain: eagain, endedAtMs, samples })}\n`);
    process.exit(0);
  }, S3_RUN_MS);
  try {
    for await (const chunk of source) {
      consumed += chunk.byteLength;
      maxChunk = Math.max(maxChunk, chunk.byteLength);
      await sleep(S3_CONSUMER_SLEEP_MS);
    }
    endedAtMs = Date.now() - started;
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ mode, error: String(err) })}\n`);
    child.kill("SIGKILL");
    process.exit(0);
  }
}

const S3_MODES = ["spawn-pipe", "fifo-bunfile-path", "fifo-bunfile-fd", "fifo-node-stream", "fifo-node-stream-fd", "fifo-net-socket", "fifo-read-loop"];
const EOF_MODES = ["fifo-bunfile-fd", "fifo-node-stream-fd", "fifo-read-loop"];

/** Does the reader see both writes and then EOF once the writer exits? */
async function eofOne(mode: string, dir: string): Promise<void> {
  const fifo = join(dir, "fifo");
  mkfifo(fifo);
  const serviceEnd = openSync(fifo, constants.O_RDWR);
  const child = Bun.spawn({ cmd: ["/bin/sh", "-c", "printf a; sleep 0.3; printf b"], stdout: serviceEnd });
  closeSync(serviceEnd);
  const started = Date.now();
  let text = "";
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ mode, text, eof: false, note: "still waiting 2s after the writer exited" })}\n`);
    process.exit(0);
  }, 2_300);
  for await (const chunk of fifoSource(mode, fifo)) {
    text += Buffer.from(chunk).toString("utf8");
  }
  await child.exited;
  process.stdout.write(`${JSON.stringify({ mode, text, eof: true, eofAfterMs: Date.now() - started })}\n`);
  process.exit(0);
}

/** 64 idle FIFO readers of one kind, then ordinary async fs work: a reader that parks a pool thread starves it. */
async function starveOne(mode: string, dir: string): Promise<void> {
  const small = join(dir, "small");
  writeFileSync(small, "x");
  const kids: ReturnType<typeof Bun.spawn>[] = [];
  for (let i = 0; i < 64; i += 1) {
    const fifo = join(dir, `idle-${i}`);
    mkfifo(fifo);
    const serviceEnd = openSync(fifo, constants.O_RDWR);
    kids.push(Bun.spawn({ cmd: ["/bin/sh", "-c", "sleep 30"], stdout: serviceEnd }));
    closeSync(serviceEnd);
    void (async () => {
      for await (const _ of fifoSource(mode, fifo)) {
        // idle writers never produce
      }
    })();
  }
  await sleep(300);
  const started = performance.now();
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ mode, idleReaders: 64, asyncFs: "starved (no result in 5s)" })}\n`);
    process.exit(0);
  }, 5_000);
  for (let i = 0; i < 20; i += 1) {
    await Bun.file(small).text();
    await Bun.write(join(dir, "out"), "y");
  }
  process.stdout.write(`${JSON.stringify({ mode, idleReaders: 64, asyncFs: `ok in ${Math.round(performance.now() - started)} ms` })}\n`);
  for (const kid of kids) {
    kid.kill("SIGKILL");
  }
  process.exit(0);
}

function runSub(command: string, mode: string): void {
  const dir = mkdtempSync(join(tmpdir(), "spike-s3-"));
  try {
    const run = spawnSync(process.execPath, [SELF, command, mode, dir], { encoding: "utf8", timeout: S3_RUN_MS + 20_000 });
    const line = run.stdout.trim().split("\n").pop() ?? "";
    console.log(line === "" ? JSON.stringify({ mode, status: run.status, signal: run.signal, stderr: run.stderr.slice(-400) }) : line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runS3(): void {
  console.log(`S3 ${process.platform} bun ${Bun.version}: writer floods 1 GiB; the consumer sleeps ${S3_CONSUMER_SLEEP_MS} ms per chunk for ${S3_RUN_MS} ms`);
  for (const mode of S3_MODES) {
    runSub("s3-consume", mode);
  }
  console.log("S3 EOF: writer prints 'a', sleeps 300 ms, prints 'b', exits");
  for (const mode of EOF_MODES) {
    runSub("s3-eof", mode);
  }
  console.log("S3 thread pool: 64 idle FIFO readers, then 20 rounds of async file reads and writes");
  for (const mode of ["fifo-node-stream-fd", "fifo-bunfile-fd", "fifo-read-loop"]) {
    runSub("s3-starve", mode);
  }
}

type Check = { name: string; pass: boolean; detail: Record<string, unknown> };

function processStateOf(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
  } catch {
    const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    return ps.status === 0 ? ps.stdout.trim() : "gone";
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await sleep(10);
  }
  return check();
}

function readSummary(path: string): ReaderSummary {
  return JSON.parse(readFileSync(path, "utf8")) as ReaderSummary;
}

async function runReader(dir: string, fifo: string, name: string, readMs: number, how: "stop" | "kill"): Promise<ReaderSummary> {
  const out = join(dir, `${name}.json`);
  const stop = join(dir, `${name}.stop`);
  const proc = Bun.spawn({ cmd: [process.execPath, SELF, "reader", fifo, out, stop], stdout: "inherit", stderr: "inherit" });
  await sleep(readMs);
  if (how === "kill") {
    proc.kill("SIGKILL");
  } else {
    writeFileSync(stop, "");
  }
  await proc.exited;
  return readSummary(out);
}

// Bytes an O_RDWR end takes before a write would block: the FIFO's kernel buffer.
function fifoCapacity(dir: string): number {
  const fifo = join(dir, "capacity");
  mkfifo(fifo);
  const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
  const one = Buffer.alloc(256, 0x62);
  let total = 0;
  try {
    for (;;) {
      total += writeSync(fd, one);
    }
  } catch {
    // EAGAIN: full
  } finally {
    closeSync(fd);
  }
  return total;
}

async function fifoChecks(dir: string): Promise<Check[]> {
  const checks: Check[] = [];
  const capacity = fifoCapacity(dir);
  checks.push({ name: "O_RDWR open works; FIFO buffer capacity", pass: capacity > 0, detail: { capacityBytes: capacity } });
  const fifo = join(dir, "fifo");
  mkfifo(fifo);
  const progress = join(dir, "progress");
  const serviceEnd = openSync(fifo, constants.O_RDWR);
  // Unbounded: Linux readers move ~1 GiB/s, and the writer must outlive every reader below.
  const writerProc = Bun.spawn({ cmd: [process.execPath, SELF, "writer", progress, String(Number.MAX_SAFE_INTEGER), "pattern"], stdout: serviceEnd, stderr: "inherit" });
  closeSync(serviceEnd);

  await sleep(1_500);
  const blockedAt = readProgress(progress).bytes;
  await sleep(500);
  const stillAt = readProgress(progress).bytes;
  checks.push({
    name: "writer blocks when the FIFO is full and nobody reads",
    pass: blockedAt === stillAt && blockedAt < MIB && writerProc.exitCode === null,
    detail: { completedWrites64KiB: blockedAt / CHUNK, stillBlockedAfter500ms: stillAt === blockedAt, writerState: processStateOf(writerProc.pid) },
  });

  const killed = await runReader(dir, fifo, "r1", 400, "kill");
  await sleep(1_000);
  const afterKill = readProgress(progress);
  await sleep(300);
  checks.push({
    name: "no EPIPE/SIGPIPE when the reader is SIGKILLed; writer blocks again",
    pass: writerProc.exitCode === null && afterKill.error === "" && readProgress(progress).bytes === afterKill.bytes,
    detail: { readerBytes: killed.bytes, writerBytes: afterKill.bytes, writerError: afterKill.error, writerState: processStateOf(writerProc.pid), exitCode: writerProc.exitCode },
  });

  const resumed = await runReader(dir, fifo, "r2", 400, "stop");
  checks.push({
    name: "a new reader resumes where the killed one stopped reading from the kernel",
    pass: resumed.ok && resumed.bytes > 0 && resumed.firstOffset >= killed.endOffset,
    detail: { killedEndOffset: killed.endOffset, resumedFirstOffset: resumed.firstOffset, resumedBytes: resumed.bytes, continuous: resumed.ok },
  });

  const first = await runReader(dir, fifo, "r3", 300, "stop");
  await sleep(300);
  const second = await runReader(dir, fifo, "r4", 300, "stop");
  checks.push({
    name: "graceful reader handoff is gap-free and duplicate-free",
    pass: first.ok && second.ok && second.firstOffset === first.endOffset,
    detail: { firstEnd: first.endOffset, secondStart: second.firstOffset, secondBytes: second.bytes },
  });
  writerProc.kill("SIGKILL");
  await writerProc.exited;
  return checks;
}

function readAll(fd: number): { text: string; ending: string } {
  const buf = Buffer.alloc(CHUNK);
  let text = "";
  for (;;) {
    try {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) {
        return { text, ending: "eof" };
      }
      text += buf.subarray(0, n).toString("utf8");
    } catch (err) {
      return { text, ending: (err as NodeJS.ErrnoException).code ?? String(err) };
    }
  }
}

async function writeThroughFifo(fifo: string, script: string): Promise<void> {
  const serviceEnd = openSync(fifo, constants.O_RDWR);
  const proc = Bun.spawn({ cmd: ["/bin/sh", "-c", script], stdout: serviceEnd, stderr: "inherit" });
  closeSync(serviceEnd);
  await proc.exited;
}

async function lifetimeChecks(dir: string): Promise<Check[]> {
  const checks: Check[] = [];
  const held = join(dir, "held");
  mkfifo(held);
  const sentinelFd = openSync(held, NONBLOCK_READ);
  const daemonFd = openSync(held, NONBLOCK_READ);
  const idleEnd = openSync(held, constants.O_RDWR);
  const idle = Bun.spawn({ cmd: ["/bin/sh", "-c", "sleep 1"], stdout: idleEnd, stderr: "inherit" });
  closeSync(idleEnd);
  const whileAlive = readAll(daemonFd);
  await idle.exited;
  await writeThroughFifo(held, "printf 'kept after exit'");
  const afterExit = readAll(sentinelFd);
  checks.push({
    name: "read fds: EAGAIN while a writer lives, data then EOF after it exits, even with a second read-only fd open",
    pass: whileAlive.ending === "EAGAIN" && afterExit.text === "kept after exit" && afterExit.ending === "eof",
    detail: { whileWriterIdle: whileAlive.ending, afterExit },
  });
  closeSync(sentinelFd);
  closeSync(daemonFd);

  const unheld = join(dir, "unheld");
  mkfifo(unheld);
  await writeThroughFifo(unheld, "printf 'lost when nobody holds the FIFO'");
  const late = openSync(unheld, NONBLOCK_READ);
  const lost = readAll(late);
  closeSync(late);
  checks.push({
    name: "buffered bytes are discarded once the last fd closes (why the sentinel must hold read fds)",
    pass: lost.text === "" && lost.ending === "eof",
    detail: { readAfterReopen: lost },
  });
  return checks;
}

/** Parent side of the death-pipe check: holds the sentinel's stdin, then starts an unrelated child. */
async function deathParent(marker: string, extraFdFile: string): Promise<void> {
  const extra = openSync(extraFdFile, "r");
  const script = `read -r cmd; printf '%s' "\${cmd:-eof}" > "${marker}.cmd"; exec /bin/sh -c 'cat <&3' > "${marker}"`;
  Bun.spawn({ cmd: ["/bin/sh", "-c", script], stdio: ["pipe", "ignore", "inherit", extra], detached: true });
  closeSync(extra);
  Bun.spawn({ cmd: ["/bin/sh", "-c", "sleep 30"], stdio: ["ignore", "ignore", "ignore"], detached: true });
  await sleep(60_000);
}

async function sentinelChecks(dir: string): Promise<Check[]> {
  const marker = join(dir, "sentinel-out");
  const extra = join(dir, "extra");
  const pidFile = join(dir, "parent.pid");
  writeFileSync(extra, "fd3 reached the exec'd drainer");
  // `exec sleep` leaves a parent that never reaps: the killed daemon stays a zombie, like under PID 1 `sleep infinity`.
  const host = Bun.spawn({
    cmd: ["/bin/sh", "-c", `"${process.execPath}" "${SELF}" death-parent "${marker}" "${extra}" & echo $! > "${pidFile}"; exec sleep 20`],
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 5_000);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await sleep(1_000);
  const killedAt = Date.now();
  process.kill(pid, "SIGKILL");
  const seen = await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8") !== "", 5_000);
  const detectMs = Date.now() - killedAt;
  const state = processStateOf(pid);
  host.kill("SIGKILL");
  return [{
    name: "death pipe: the sentinel sees EOF when its daemon is SIGKILLed and left a zombie, despite a later child",
    pass: seen && detectMs < 1_000 && state.startsWith("Z"),
    detail: { detectMs, daemonState: state, sentinelRead: readFileSync(`${marker}.cmd`, "utf8"), fd3: seen ? readFileSync(marker, "utf8") : "" },
  }];
}

async function runS5(): Promise<void> {
  console.log(`S5 ${process.platform} bun ${Bun.version}`);
  const dir = mkdtempSync(join(tmpdir(), "spike-s5-"));
  try {
    const checks = [...(await fifoChecks(dir)), ...(await lifetimeChecks(dir)), ...(await sentinelChecks(dir))];
    for (const check of checks) {
      console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name} ${JSON.stringify(check.detail)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "writer":
    writer(rest[0] ?? "", Number(rest[1]), rest[2] === "pattern");
    break;
  case "reader":
    await reader(rest[0] ?? "", rest[1] ?? "", rest[2] ?? "");
    break;
  case "s3-consume":
    await consume(rest[0] ?? "", rest[1] ?? "");
    break;
  case "s3-eof":
    await eofOne(rest[0] ?? "", rest[1] ?? "");
    break;
  case "s3-starve":
    await starveOne(rest[0] ?? "", rest[1] ?? "");
    break;
  case "death-parent":
    await deathParent(rest[0] ?? "", rest[1] ?? "");
    break;
  case "s3":
    runS3();
    break;
  case "s5":
    await runS5();
    break;
  default:
    console.log("usage: fifo-spikes.ts s3|s5");
}
