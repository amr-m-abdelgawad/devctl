import { spawn, type Subprocess } from "bun";
import { KindProcessStart, newError, wrapError } from "./errors.ts";
import { commandMatches, inspectProcessUnix, killProcessTreeUnix, type ProcessIdentity } from "./processes/unix.ts";
import { inspectProcessWindows, killProcessTreeWindows } from "./processes/windows.ts";
import { processAlive } from "./storage.ts";

const DEFAULT_GRACE_MS = 10_000;
const KILL_WAIT_MS = 2_000;
const ADOPT_POLL_MS = 500;

export type Stream = "stdout" | "stderr";
export type LineHandler = (stream: Stream, line: string) => void;

export type ProcessSpec = {
  name: string;
  args: string[];
  shell: boolean;
  workDir: string;
  env: Record<string, string>;
  graceMs: number;
  captureStdout?: boolean;
  captureStderr?: boolean;
  onLine?: LineHandler;
  onExit?: (code: number, err?: Error) => void;
};

export type AdoptSpec = {
  name: string;
  pid: number;
  args: string[];
  workDir: string;
  startTime: Date;
  onExit?: (code: number, err?: Error) => void;
};

export type Handle = {
  name: string;
  pid: number;
  startTime: Date;
  workDir: string;
  args: string[];
  done: Promise<{ code: number; err?: Error }>;
  proc?: Subprocess;
};

export class ProcessManager {
  private readonly running = new Map<string, Handle>();

  async start(spec: ProcessSpec): Promise<Handle> {
    const existing = this.running.get(spec.name);
    if (existing && processAlive(existing.pid)) {
      return existing;
    }
    this.running.delete(spec.name);
    if (spec.args.length === 0) {
      throw newError(KindProcessStart, "empty command");
    }
    const cmd = spec.shell ? shellCommand(spec.args) : spec.args;
    let proc: Subprocess;
    try {
      proc = spawn({
        cmd,
        cwd: spec.workDir === "" ? undefined : spec.workDir,
        env: spec.env,
        stdout: spec.captureStdout === false ? "ignore" : "pipe",
        stderr: spec.captureStderr === false ? "ignore" : "pipe",
        stdin: "ignore",
        detached: process.platform !== "win32",
      });
    } catch (err) {
      throw wrapError(KindProcessStart, `failed to start ${spec.name}`, err);
    }
    const handle: Handle = {
      name: spec.name,
      pid: proc.pid ?? 0,
      startTime: new Date(),
      workDir: spec.workDir,
      args: [...spec.args],
      proc,
      done: Promise.resolve({ code: 0 }),
    };
    void pumpLines(proc.stdout, "stdout", spec.onLine);
    void pumpLines(proc.stderr, "stderr", spec.onLine);
    handle.done = proc.exited.then((code) => {
      const exitCode = typeof code === "number" ? code : 0;
      const err = exitCode === 0 ? undefined : new Error(`exited with code ${exitCode}`);
      if (this.running.get(spec.name) === handle) {
        this.running.delete(spec.name);
      }
      if (spec.onExit) {
        spec.onExit(exitCode, err);
      }
      return { code: exitCode, err };
    });
    this.running.set(spec.name, handle);
    return handle;
  }

  adopt(spec: AdoptSpec): Handle {
    const existing = this.running.get(spec.name);
    if (existing && processAlive(existing.pid)) {
      return existing;
    }
    if (!processAlive(spec.pid)) {
      throw newError(KindProcessStart, `cannot adopt ${spec.name}: pid ${spec.pid} is not running`);
    }
    const handle: Handle = {
      name: spec.name,
      pid: spec.pid,
      startTime: spec.startTime,
      workDir: spec.workDir,
      args: [...spec.args],
      done: Promise.resolve({ code: 0 }),
    };
    handle.done = pollAdopted(spec.pid).then((code) => {
      if (this.running.get(spec.name) === handle) {
        this.running.delete(spec.name);
      }
      if (spec.onExit) {
        spec.onExit(code, code === 0 ? undefined : new Error(`exited with code ${code}`));
      }
      return { code };
    });
    this.running.set(spec.name, handle);
    return handle;
  }

  async stop(name: string, graceMs: number): Promise<void> {
    const handle = this.running.get(name);
    if (!handle) {
      return;
    }
    const grace = graceMs > 0 ? graceMs : DEFAULT_GRACE_MS;
    await killProcessTree(handle.pid, "SIGTERM");
    const finished = await raceDone(handle.done, grace);
    if (!finished) {
      await killProcessTree(handle.pid, "SIGKILL");
      const killed = await raceDone(handle.done, KILL_WAIT_MS);
      if (!killed) {
        throw newError(KindProcessStart, `process ${name} did not exit after SIGKILL`);
      }
    }
    this.running.delete(name);
  }

  get(name: string): Handle | undefined {
    return this.running.get(name);
  }

  all(): Handle[] {
    return [...this.running.values()];
  }
}

export { processAlive };

export async function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (process.platform === "win32") {
    await killProcessTreeWindows(pid, signal);
    return;
  }
  await killProcessTreeUnix(pid, signal);
}

export async function inspectProcess(pid: number): Promise<ProcessIdentity | undefined> {
  if (process.platform === "win32") {
    return inspectProcessWindows(pid);
  }
  return inspectProcessUnix(pid);
}

const START_TIME_TOLERANCE_MS = 2_000;

export function sameProcess(expected: { args: string[]; workDir: string; startTime?: Date }, observed: ProcessIdentity): boolean {
  if (expected.workDir !== "" && observed.cwd !== "" && normalizePath(expected.workDir) !== normalizePath(observed.cwd)) {
    return false;
  }
  if (!commandMatches(expected.args, observed.command)) {
    return false;
  }
  const expectedMs = timeMs(expected.startTime);
  const observedMs = timeMs(observed.startTime);
  if (expectedMs !== undefined && observedMs !== undefined) {
    return Math.abs(expectedMs - observedMs) <= START_TIME_TOLERANCE_MS;
  }
  return true;
}

function timeMs(value: Date | string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function shellCommand(args: string[]): string[] {
  if (process.platform === "win32") {
    return ["cmd.exe", "/c", args.join(" ")];
  }
  return ["/bin/sh", "-c", args.join(" ")];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

async function pollAdopted(pid: number): Promise<number> {
  while (processAlive(pid)) {
    await sleep(ADOPT_POLL_MS);
  }
  return 0;
}

async function pumpLines(stream: ReadableStream<Uint8Array> | number | undefined, kind: Stream, handler?: LineHandler): Promise<void> {
  if (!stream || typeof stream === "number" || !handler) {
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      if (buf !== "") {
        handler(kind, buf);
      }
      return;
    }
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      handler(kind, line.replace(/\r$/, ""));
    }
  }
}

async function raceDone(done: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), ms);
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
