import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { replayDrained } from "./fifo-drain.ts";
import { fifoChunks } from "./fifo-reader.ts";
import { drainSpoolDir, drainStoppedPath, stopPreviousDrainer } from "./fifo-sentinel.ts";

const SENTINEL_MODULE = fileURLToPath(new URL("./fifo-sentinel.ts", import.meta.url));
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

type Setup = { root: string; fifo: string; service: ReturnType<typeof Bun.spawn> };

// A service writing numbered lines into a FIFO it holds O_RDWR; each line waits for `gate` to exist.
function service(lines: number): Setup {
  const root = mkdtempSync(join(tmpdir(), "devctl-sentinel-"));
  dirs.push(root);
  const fifo = join(root, "api.stdout");
  expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
  const serviceEnd = openSync(fifo, constants.O_RDWR);
  const gate = join(root, "go");
  const script = `while [ ! -f "${gate}" ]; do sleep 0.02; done; i=1; while [ $i -le ${lines} ]; do echo line-$i; i=$((i+1)); done`;
  const proc = Bun.spawn({ cmd: ["/bin/sh", "-c", script], stdout: serviceEnd, stderr: "ignore" });
  closeSync(serviceEnd);
  kids.push(proc);
  return { root, fifo, service: proc };
}

// A stand-in daemon: holds the FIFO through a sentinel, then optionally rearranges it, then idles until killed.
function daemon(setup: Setup, after = ""): ReturnType<typeof Bun.spawn> {
  const code = [
    `import { openSync, constants } from "node:fs";`,
    `import { StdioSentinel } from ${JSON.stringify(SENTINEL_MODULE)};`,
    `const [root, fifo, pid] = process.argv.slice(1);`,
    `const fd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);`,
    `const sentinel = new StdioSentinel(root, 64 * 1024 * 1024);`,
    `sentinel.hold([{ fd, service: "api", stream: "stdout", pid: Number(pid) }]);`,
    after,
    `console.log("ready");`,
    `setInterval(() => undefined, 60_000);`,
  ].join("\n");
  const proc = Bun.spawn({ cmd: [process.execPath, "-e", code, setup.root, setup.fifo, String(setup.service.pid)], stdout: "pipe", stderr: "inherit" });
  kids.push(proc);
  return proc;
}

async function ready(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  expect(Buffer.from(value ?? new Uint8Array()).toString("utf8")).toContain("ready");
  reader.releaseLock();
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  return check();
}

async function replayedText(root: string): Promise<string> {
  let text = "";
  await replayDrained(drainSpoolDir(root), () => (_stream, bytes) => {
    text += Buffer.from(bytes).toString("utf8");
    return true;
  });
  return text;
}

async function fifoRest(fifo: string): Promise<string> {
  const fd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  let text = "";
  for await (const chunk of fifoChunks(fd)) {
    text += Buffer.from(chunk).toString("utf8");
  }
  closeSync(fd);
  return text;
}

function numbered(text: string): number[] {
  return text.trimEnd().split("\n").map((line) => Number(line.slice("line-".length)));
}

describe.skipIf(process.platform === "win32")("stdio sentinel", () => {
  test("when its daemon is killed it drains the FIFO, and a new owner stops it and loses nothing", async () => {
    const setup = service(100_000);
    const owner = daemon(setup);
    await ready(owner);
    owner.kill("SIGKILL");
    writeFileSync(join(setup.root, "go"), "");
    // The FIFO holds 8-64 KiB; ~1.1 MB of output only fits if the drainer took over.
    expect(await waitFor(() => existsSync(join(drainSpoolDir(setup.root), "00000000.spool")), 10_000)).toBe(true);
    await stopPreviousDrainer(setup.root);
    expect(readFileSync(drainStoppedPath(setup.root), "utf8").trim()).not.toBe("");
    const text = (await replayedText(setup.root)) + (await fifoRest(setup.fifo));
    expect(numbered(text)).toEqual(Array.from({ length: 100_000 }, (_, i) => i + 1));
    expect(await setup.service.exited).toBe(0);
  }, 30_000);

  test("a stood-down sentinel exits without draining", async () => {
    const setup = service(20_000);
    const owner = daemon(setup, "sentinel.hold([]);");
    await ready(owner);
    owner.kill("SIGKILL");
    writeFileSync(join(setup.root, "go"), "");
    await Bun.sleep(1_000);
    expect(existsSync(drainSpoolDir(setup.root))).toBe(false);
    expect(setup.service.exitCode).toBeNull();
    expect(numbered(await fifoRest(setup.fifo))).toEqual(Array.from({ length: 20_000 }, (_, i) => i + 1));
  }, 30_000);

  test("a sentinel whose generation is no longer the latest leaves the drain to the newer one", async () => {
    const setup = service(20_000);
    const owner = daemon(setup, `(await import("node:fs")).writeFileSync(root + "/sentinel.generation", "99\\n");`);
    await ready(owner);
    owner.kill("SIGKILL");
    writeFileSync(join(setup.root, "go"), "");
    await Bun.sleep(1_000);
    expect(existsSync(drainSpoolDir(setup.root))).toBe(false);
    expect(numbered(await fifoRest(setup.fifo))).toEqual(Array.from({ length: 20_000 }, (_, i) => i + 1));
  }, 30_000);

  test("a recorded pid that now belongs to another process is not signalled", async () => {
    const root = mkdtempSync(join(tmpdir(), "devctl-sentinel-"));
    dirs.push(root);
    const other = Bun.spawn({ cmd: ["/bin/sh", "-c", "sleep 30"], stdout: "ignore" });
    kids.push(other);
    writeFileSync(join(root, "sentinels.json"), JSON.stringify({ pids: [other.pid] }));
    await stopPreviousDrainer(root);
    await Bun.sleep(100);
    expect(other.exitCode).toBeNull();
  });
});
