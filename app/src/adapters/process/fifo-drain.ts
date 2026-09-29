import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, readSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_LOG_CAP_BYTES } from "../../domain/logs/budgets.ts";
import { directoryBytes, ensureStdioDir, FIFO_SEGMENT_BYTES, readyPath, segmentPath } from "./fifo-segments.ts";

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
        await sleep(IDLE_MS);
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
        await sleep(IDLE_MS);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      await sleep(IDLE_MS);
    }
  }
}
