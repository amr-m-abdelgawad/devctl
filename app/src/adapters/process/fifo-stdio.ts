import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DEFAULT_LOG_CAP_BYTES } from "../../domain/logs/budgets.ts";
import { ensureFifo } from "./fifo-drain.ts";
import { ensureStdioDir, readySequences, segmentPath, serviceStdioDir } from "./fifo-segments.ts";
import { deliverEnd } from "./output-pump.ts";
import type { ProcessChunkHandler } from "../../ports/process-runtime.ts";

const READER_WAIT_MS = 1_000;
const FOLLOW_IDLE_MS = 5;

export type StdioChunk = ProcessChunkHandler;

export type ServiceStdio = {
  stdoutFd: number;
  stderrFd: number;
  releaseParentEnds(): void;
  follow(onChunk: StdioChunk, paused?: () => boolean, done?: () => boolean): Promise<void>;
};

/** POSIX FIFO stdio with a detached drainer. Undefined on Windows or when setup fails. */
export function openServiceStdio(root: string, service: string, spoolMaxBytes = DEFAULT_LOG_CAP_BYTES): ServiceStdio | undefined {
  if (process.platform === "win32" || root === "") {
    return undefined;
  }
  try {
    const stdout = openStream(root, service, "stdout", spoolMaxBytes);
    const stderr = openStream(root, service, "stderr", spoolMaxBytes);
    return {
      stdoutFd: stdout.writeFd,
      stderrFd: stderr.writeFd,
      releaseParentEnds: () => {
        stdout.release();
        stderr.release();
      },
      follow: (onChunk, paused, done) => followBoth(stdout.dir, stderr.dir, onChunk, paused, done),
    };
  } catch {
    return undefined;
  }
}

export function resumeServiceStdio(root: string, service: string): Pick<ServiceStdio, "follow"> | undefined {
  if (process.platform === "win32" || root === "") {
    return undefined;
  }
  const stdoutDir = streamDir(root, service, "stdout");
  const stderrDir = streamDir(root, service, "stderr");
  if (!existsSync(stdoutDir) && !existsSync(stderrDir)) {
    return undefined;
  }
  return {
    follow: (onChunk, paused, done) => followBoth(stdoutDir, stderrDir, onChunk, paused, done),
  };
}

type StreamEnds = {
  dir: string;
  writeFd: number;
  release: () => void;
};

function openStream(root: string, service: string, stream: "stdout" | "stderr", spoolMaxBytes: number): StreamEnds {
  const dir = streamDir(root, service, stream);
  ensureStdioDir(dir);
  const fifo = join(dir, "fifo");
  ensureFifo(fifo);
  const holder = openSync(fifo, constants.O_RDWR);
  const child = spawnDrain(fifo, dir, spoolMaxBytes);
  waitForReader(dir);
  // Blocking write end. O_NONBLOCK here is inherited by the service and turns a
  // full FIFO into EAGAIN, which kills Python and Node instead of pausing them.
  const writeFd = openSync(fifo, constants.O_WRONLY);
  writeFileSync(join(dir, "sentinel"), `${JSON.stringify({ pid: child.pid ?? 0, at: Date.now() })}\n`, { mode: 0o600 });
  return {
    dir,
    writeFd,
    release: () => {
      closeQuiet(holder);
      child.unref();
    },
  };
}

function streamDir(root: string, service: string, stream: "stdout" | "stderr"): string {
  return join(serviceStdioDir(root, service), stream);
}

function spawnDrain(fifo: string, dir: string, spoolMaxBytes: number): ReturnType<typeof spawn> {
  const max = String(spoolMaxBytes > 0 ? spoolMaxBytes : DEFAULT_LOG_CAP_BYTES);
  const cmd = Bun.isStandaloneExecutable === true
    ? [process.execPath, "_fifo_drain", fifo, dir, max]
    : [process.execPath, "-e", drainEval(), fifo, dir, max];
  return spawn(cmd[0] ?? process.execPath, cmd.slice(1), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
}

function drainEval(): string {
  const mod = fileURLToPath(new URL("./fifo-drain.ts", import.meta.url));
  return `import { runFifoDrain } from ${JSON.stringify(mod)}; await runFifoDrain(process.argv[1] ?? "", process.argv[2] ?? "", Number(process.argv[3] ?? ""));`;
}

function waitForReader(dir: string): void {
  const marker = join(dir, "reader");
  const deadline = Date.now() + READER_WAIT_MS;
  while (!existsSync(marker)) {
    if (Date.now() >= deadline) {
      throw new Error("fifo drainer did not start");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

async function followBoth(
  stdoutDir: string,
  stderrDir: string,
  onChunk: StdioChunk,
  paused?: () => boolean,
  done?: () => boolean,
): Promise<void> {
  await Promise.all([
    followDir(stdoutDir, (bytes) => onChunk("stdout", bytes), paused, done).then(() => deliverEnd("stdout", onChunk)),
    followDir(stderrDir, (bytes) => onChunk("stderr", bytes), paused, done).then(() => deliverEnd("stderr", onChunk)),
  ]);
}

async function followDir(
  dir: string,
  onBytes: (bytes: Uint8Array) => boolean,
  paused?: () => boolean,
  done?: () => boolean,
): Promise<void> {
  // Segments that were delivered but could not be deleted. Everything else is
  // deleted once delivered, so nothing needs remembering per segment.
  const stuck = new Set<number>();
  while (done?.() !== true) {
    const progressed = await consumeReady(dir, stuck, onBytes, paused);
    if (!progressed) {
      await sleep(FOLLOW_IDLE_MS);
    }
  }
  await consumeReady(dir, stuck, onBytes, paused);
}

async function consumeReady(
  dir: string,
  stuck: Set<number>,
  onBytes: (bytes: Uint8Array) => boolean,
  paused?: () => boolean,
): Promise<boolean> {
  let progressed = false;
  for (const seq of readySequences(dir)) {
    if (stuck.has(seq)) {
      continue;
    }
    const path = segmentPath(dir, seq);
    if (!existsSync(path)) {
      continue;
    }
    const bytes = new Uint8Array(readFileSync(path));
    let accepted = false;
    while (!accepted) {
      if (paused?.() === true) {
        await sleep(FOLLOW_IDLE_MS);
      }
      accepted = onBytes(bytes) !== false;
      if (!accepted) {
        await sleep(FOLLOW_IDLE_MS);
      }
    }
    if (!unlinkQuiet(path)) {
      stuck.add(seq);
    }
    unlinkQuiet(join(dir, `ready-${String(seq).padStart(8, "0")}`));
    progressed = true;
    // One segment per turn, so a service that keeps writing cannot starve
    // timers, RPC, and health checks on this event loop.
    await nextTurn();
  }
  return progressed;
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

function unlinkQuiet(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
