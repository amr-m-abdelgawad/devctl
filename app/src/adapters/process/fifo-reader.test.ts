import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fifoChunks } from "./fifo-reader.ts";

const dirs: string[] = [];
const kids: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const kid of kids.splice(0)) {
    kid.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A FIFO whose only writer is `script`, holding an O_RDWR end like a service.
function fifoWriter(script: string): { readFd: () => number; proc: ReturnType<typeof Bun.spawn> } {
  const dir = mkdtempSync(join(tmpdir(), "devctl-fifo-reader-"));
  dirs.push(dir);
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
