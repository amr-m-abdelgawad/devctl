import type { ProcessRuntime } from "../../ports/process-runtime.ts";
import { spawn, type Subprocess } from "bun";
import { KindProcessStart, newError, wrapError } from "../../shared/errors.ts";
import { RUN_ONCE_DRAIN_GRACE_MS, SPLIT_MAX_BYTES } from "../../domain/logs/budgets.ts";
import { MAX_LOG_LINE_CHARS } from "../../domain/logs/logs.ts";
import { commandMatches, inspectProcessUnix, killProcessTreeUnix, sampleResourceUsageUnix, type ProcessIdentity, type ResourceSample } from "./unix.ts";
import { inspectProcessWindows, killProcessTreeWindows, sampleResourceUsageWindows } from "./windows.ts";
import { processAlive } from "../storage/storage.ts";
import { groupHasLiveMembers } from "./liveness.ts";
import { closeSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pumpChunks, pumpLines, type ChunkHandler, type LineHandler, type StreamName } from "./output-pump.ts";
import { LineSplitter } from "../storage/ingest/line-splitter.ts";
import { openServiceStdio, resumeServiceStdio } from "./fifo-stdio.ts";
import { forgetManagedPid, rememberManagedPid } from "./peer-caller.ts";
import { adoptContainer, startContainer, containerEnvironment, type ContainerControl, type ContainerLaunchSpec } from "../containers/containers.ts";

const DEFAULT_GRACE_MS = 10_000;
const KILL_WAIT_MS = 2_000;
const ADOPT_POLL_MS = 500;
const GROUP_POLL_MS = 50;
// Cap per-stream captured output for a transient run (tasks, exec_service) so a
// noisy command cannot grow supervisor memory without bound. Live logging via
// `onLine` is untouched — only the returned string is capped, with a marker.
const MAX_CAPTURE_BYTES = 1024 * 1024;
const CAPTURE_TRUNCATED_MARKER = "\n...[truncated]\n";
// Force-break an unterminated line in the line pump at this size so a
// newline-free flood cannot grow the pending buffer without bound. Applies to
// both transient captures and long-running service streaming.
const MAX_LINE_BYTES = 1024 * 1024;

export type Stream = StreamName;
export type { LineHandler };

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
  /** Raw stdout/stderr. Returning false keeps the chunk until the pipeline has room. */
  onChunk?: ChunkHandler;
  /** When true, the pump stops reading so a full spool can apply backpressure. */
  paused?: () => boolean;
  onExit?: (code: number, err?: Error) => void;
};

export type AdoptSpec = {
  name: string;
  pid: number;
  args: string[];
  workDir: string;
  startTime: Date;
  onChunk?: ChunkHandler;
  paused?: () => boolean;
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
  container?: ContainerControl;
};

export class ProcessManager implements ProcessRuntime {
  constructor(private readonly options: { stdioRoot?: string; spoolMaxBytes?: number } = {}) {}

  isRunning(name: string): boolean {
    const handle = this.running.get(name);
    return handle !== undefined && handleStillRunning(handle);
  }

  private readonly running = new Map<string, Handle>();

  async start(spec: ProcessSpec): Promise<Handle> {
    const existing = this.running.get(spec.name);
    if (existing && handleStillRunning(existing)) {
      return existing;
    }
    this.running.delete(spec.name);
    if (spec.args.length === 0) {
      throw newError(KindProcessStart, "empty command");
    }
    const cmd = spec.shell ? shellCommand(spec.args) : spec.args;
    const stdio = this.options.stdioRoot === undefined ? undefined : openServiceStdio(this.options.stdioRoot, spec.name, this.options.spoolMaxBytes);
    let proc: Subprocess;
    let usingFifo = stdio !== undefined;
    try {
      proc = spawnService(spec, cmd, usingFifo ? stdio : undefined);
    } catch (err) {
      stdio?.releaseParentEnds();
      if (!usingFifo) {
        throw wrapError(KindProcessStart, `failed to start ${spec.name}`, err);
      }
      usingFifo = false;
      try {
        proc = spawnService(spec, cmd, undefined);
      } catch (fallback) {
        throw wrapError(KindProcessStart, `failed to start ${spec.name}`, fallback);
      }
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
    rememberManagedPid(handle.pid);
    let followStop = false;
    if (usingFifo && stdio) {
      closeQuiet(stdio.stdoutFd);
      closeQuiet(stdio.stderrFd);
      stdio.releaseParentEnds();
      const deliver = chunkDeliver(spec);
      void stdio.follow(deliver, spec.paused, () => followStop);
    } else {
      const livePump = { paused: spec.paused, maxLineBytes: SPLIT_MAX_BYTES, maxChars: MAX_LOG_LINE_CHARS };
      if (spec.onChunk) {
        void pumpChunks(proc.stdout, "stdout", spec.onChunk, livePump);
        void pumpChunks(proc.stderr, "stderr", spec.onChunk, livePump);
      } else {
        void pumpLines(proc.stdout, "stdout", spec.onLine, livePump);
        void pumpLines(proc.stderr, "stderr", spec.onLine, livePump);
      }
    }
    handle.done = proc.exited.then((code) => {
      const exitCode = typeof code === "number" ? code : 0;
      const err = exitCode === 0 ? undefined : new Error(`exited with code ${exitCode}`);
      forgetManagedPid(handle.pid);
      setTimeout(() => {
        followStop = true;
      }, RUN_ONCE_DRAIN_GRACE_MS);
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

  async runOnce(spec: Omit<ProcessSpec, "onExit">): Promise<{ code: number; stdout: string; stderr: string }> {
    if (spec.args.length === 0) throw newError(KindProcessStart, "empty command");
    let proc: Subprocess;
    try {
      proc = spawn({ cmd: spec.shell ? shellCommand(spec.args) : spec.args, cwd: spec.workDir || undefined, env: spec.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (err) {
      throw wrapError(KindProcessStart, `failed to run ${spec.name}`, err);
    }
    // Cap each captured stream by UTF-8 byte size (tracked incrementally so it
    // is O(1) per line), including the truncation marker. onLine still fires for
    // every line, so live logging is unaffected by capture truncation.
    const caps: Record<Stream, { text: string; bytes: number; truncated: boolean }> = {
      stdout: { text: "", bytes: 0, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
    };
    const collect = (stream: Stream, line: string): void => {
      const cap = caps[stream];
      if (!cap.truncated) {
        const add = Buffer.byteLength(line, "utf8") + 1;
        if (cap.bytes + add > MAX_CAPTURE_BYTES) {
          cap.text += CAPTURE_TRUNCATED_MARKER;
          cap.truncated = true;
        } else {
          cap.text += `${line}\n`;
          cap.bytes += add;
        }
      }
      spec.onLine?.(stream, line);
    };
    const pumps = [
      pumpLines(proc.stdout, "stdout", collect, { maxLineBytes: MAX_LINE_BYTES }),
      pumpLines(proc.stderr, "stderr", collect, { maxLineBytes: MAX_LINE_BYTES }),
    ];
    const code = await proc.exited;
    await Promise.race([
      Promise.all(pumps),
      sleep(RUN_ONCE_DRAIN_GRACE_MS),
    ]);
    return { code: typeof code === "number" ? code : 0, stdout: caps.stdout.text, stderr: caps.stderr.text };
  }

  async startContainer(spec: ContainerLaunchSpec): Promise<Handle> {
    const existing = this.running.get(spec.name);
    if (existing && handleStillRunning(existing)) return existing;
    const control = await startContainer({ ...spec, env: containerEnvironment(spec.env) });
    const handle: Handle = {
      name: spec.name, pid: 0, startTime: new Date(), workDir: spec.workDir,
      args: [...spec.command], done: control.done, container: control,
    };
    control.done.finally(() => {
      if (this.running.get(spec.name) === handle) this.running.delete(spec.name);
    });
    this.running.set(spec.name, handle);
    return handle;
  }

  async adoptContainer(spec: Omit<ContainerLaunchSpec, "image" | "command" | "env" | "ports" | "targetPorts" | "volumes">): Promise<Handle | undefined> {
    const existing = this.running.get(spec.name);
    if (existing && handleStillRunning(existing)) return existing;
    const control = await adoptContainer(spec.runtime, spec.containerName, spec.onLine, spec.onExit, spec.onChunk, spec.paused);
    if (!control) return undefined;
    const handle: Handle = { name: spec.name, pid: 0, startTime: new Date(), workDir: spec.workDir, args: [], done: control.done, container: control };
    control.done.finally(() => { if (this.running.get(spec.name) === handle) this.running.delete(spec.name); });
    this.running.set(spec.name, handle);
    return handle;
  }

  /** Marks a keep-services shutdown so the next daemon keeps reading the FIFOs. */
  handoff(): void {
    const root = this.options.stdioRoot;
    if (root === undefined) {
      return;
    }
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      writeFileSync(join(root, "_drain"), `${Date.now()}\n`, { mode: 0o600 });
    } catch {
      // the detached drainer already holds the read end
    }
  }

  adopt(spec: AdoptSpec): Handle {
    const existing = this.running.get(spec.name);
    if (existing && handleStillRunning(existing)) {
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
    rememberManagedPid(spec.pid);
    let followStop = false;
    const onChunk = spec.onChunk;
    const resumed = this.options.stdioRoot === undefined || onChunk === undefined
      ? undefined
      : resumeServiceStdio(this.options.stdioRoot, spec.name);
    if (resumed && onChunk) {
      void resumed.follow(onChunk, spec.paused, () => followStop);
    }
    handle.done = pollAdopted(spec.pid).then((code) => {
      forgetManagedPid(spec.pid);
      setTimeout(() => {
        followStop = true;
      }, RUN_ONCE_DRAIN_GRACE_MS);
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
    if (handle.container) {
      await handle.container.stop(grace);
      this.running.delete(name);
      return;
    }
    await killProcessTree(handle.pid, "SIGTERM");
    const finished = await raceGroup(handle.pid, handle.done, grace);
    if (!finished) {
      await killProcessTree(handle.pid, "SIGKILL");
      const killed = await raceGroup(handle.pid, handle.done, KILL_WAIT_MS);
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

export function handleStillRunning(handle: Handle): boolean {
  if (handle.container) return handle.container.running();
  if (handle.proc) {
    return handle.proc.exitCode === null && !handle.proc.killed;
  }
  return processAlive(handle.pid);
}

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

export type { ProcessIdentity, ResourceSample };

export async function sampleResourceUsage(pids: number[]): Promise<Map<number, ResourceSample>> {
  if (process.platform === "win32") {
    return sampleResourceUsageWindows(pids);
  }
  return sampleResourceUsageUnix(pids);
}

const START_TIME_TOLERANCE_MS = 2_000;
// Adoption only. A reused pid is a newer process. Sleep on WSL or inside a
// dev container moves the wall clock relative to /proc and makes the
// reconstructed start look older, which must still count as the same process.
const ADOPT_START_SKEW_MS = 15_000;

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

// sameProcess, plus proof: the working directory or the start time was
// actually compared, not skipped for lack of data. commandMatches alone
// accepts an executable basename, so on Windows (tasklist reports neither
// cwd nor start time) any process of the same program would pass. Used
// before killing a port holder, where leaving an unverifiable process
// running is the safe outcome.
export function provenSameProcess(expected: { args: string[]; workDir: string; startTime?: Date }, observed: ProcessIdentity): boolean {
  if (!sameProcess(expected, observed)) {
    return false;
  }
  const cwdCompared = expected.workDir !== "" && observed.cwd !== "";
  const startCompared = timeMs(expected.startTime) !== undefined && timeMs(observed.startTime) !== undefined;
  return cwdCompared || startCompared;
}

export function sameAdoptedProcess(expected: { args: string[]; workDir: string; startTime?: Date }, observed: ProcessIdentity): boolean {
  if (expected.workDir !== "" && observed.cwd !== "" && normalizePath(expected.workDir) !== normalizePath(observed.cwd)) {
    return false;
  }
  if (!commandMatches(expected.args, observed.command)) {
    return false;
  }
  const expectedMs = timeMs(expected.startTime);
  const observedMs = timeMs(observed.startTime);
  if (expectedMs === undefined || observedMs === undefined) {
    return true;
  }
  return observedMs - expectedMs <= ADOPT_START_SKEW_MS;
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

function spawnService(spec: ProcessSpec, cmd: string[], stdio: { stdoutFd: number; stderrFd: number } | undefined): Subprocess {
  return spawn({
    cmd,
    cwd: spec.workDir === "" ? undefined : spec.workDir,
    env: spec.env,
    stdout: spec.captureStdout === false ? "ignore" : stdio?.stdoutFd ?? "pipe",
    stderr: spec.captureStderr === false ? "ignore" : stdio?.stderrFd ?? "pipe",
    stdin: "ignore",
    detached: true,
    windowsHide: true,
  });
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

async function raceGroup(pid: number, done: Promise<unknown>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let leaderDone = false;
  void done.then(() => {
    leaderDone = true;
  });
  while (Date.now() < deadline) {
    const live = groupHasLiveMembers(pid);
    if (live === false || (live === undefined && leaderDone)) {
      return true;
    }
    await sleep(GROUP_POLL_MS);
  }
  const live = groupHasLiveMembers(pid);
  return live === false || (live === undefined && leaderDone);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

function chunkDeliver(spec: ProcessSpec): ChunkHandler {
  const stdout = new LineSplitter({ maxBytes: SPLIT_MAX_BYTES, maxChars: MAX_LOG_LINE_CHARS });
  const stderr = new LineSplitter({ maxBytes: SPLIT_MAX_BYTES, maxChars: MAX_LOG_LINE_CHARS });
  return (stream, bytes) => {
    if (spec.onChunk) {
      return spec.onChunk(stream, bytes);
    }
    const splitter = stream === "stdout" ? stdout : stderr;
    for (const line of splitter.push(bytes)) {
      spec.onLine?.(stream, line);
    }
    return true;
  };
}
