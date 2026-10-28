import type { Subprocess } from "bun";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { processAlive, writeFileSecure } from "../storage/storage.ts";
import { drainCommand, type DrainStream } from "./fifo-drain.ts";
import { sleepMs } from "./fifo-reader.ts";
import { captureProcessOutput, parseProcCmdline } from "./unix.ts";

const FIRST_EXTRA_FD = 3;
const STOP_POLL_MS = 20;
const STOP_WAIT_MS = 5_000;
const KILL_WAIT_MS = 1_000;

// Blocks reading the daemon's pipe. EOF means the daemon is gone, however it
// died: a SIGKILLed or zombie daemon has closed its end too. A line instead
// stands this sentinel down. Of several sentinels, only the one whose
// generation the daemon recorded last execs the drainer, which inherits the
// FIFO read ends at fd 3 and up. Paths and the command come in as arguments,
// never as script text.
const SENTINEL_SCRIPT = [
  'generation_file=$1; mine=$2; shift 2',
  'if read -r _; then exit 0; fi',
  'read -r current < "$generation_file" || exit 0',
  '[ "$current" = "$mine" ] || exit 0',
  'exec "$@"',
].join("\n");


export function drainSpoolDir(root: string): string {
  return join(root, "drain");
}

export function drainStoppedPath(root: string): string {
  return join(root, "drain.stopped");
}

// stdin is the daemon's pipe; stderr appends to drain.log.
type SentinelProcess = Subprocess<"pipe", "ignore", number>;

function generationPath(root: string): string {
  return join(root, "sentinel.generation");
}

function sentinelsPath(root: string): string {
  return join(root, "sentinels.json");
}

/**
 * One POSIX sh process per daemon holding every live FIFO read end, so
 * output a service writes after the daemon dies waits in the FIFO instead
 * of being discarded when the last reader closes. When the daemon dies it
 * execs one drainer for all of them.
 */
export class StdioSentinel {
  private generation: number;
  private current: SentinelProcess | undefined;

  constructor(
    private readonly root: string,
    private readonly spoolMaxBytes: number,
    private readonly ingestSpoolDir?: string,
  ) {
    this.generation = readGeneration(root);
  }

  /**
   * Replaces the sentinel with one that holds exactly `streams`. The new one
   * is recorded before the old one stands down, so at any moment one of them
   * is armed to drain, and the generation file picks exactly one.
   */
  hold(streams: readonly DrainStream[]): void {
    const previous = this.current;
    const generation = this.generation + 1;
    const next = streams.length === 0 ? undefined : this.spawn(streams, generation);
    const armed = [next, previous].filter((proc): proc is NonNullable<typeof proc> => proc !== undefined);
    writeFileSecure(sentinelsPath(this.root), `${JSON.stringify({ pids: armed.map((proc) => proc.pid) })}\n`);
    writeFileSecure(generationPath(this.root), `${generation}\n`);
    this.generation = generation;
    this.current = next;
    if (previous !== undefined) {
      standDown(previous);
      writeFileSecure(sentinelsPath(this.root), `${JSON.stringify({ pids: next === undefined ? [] : [next.pid] })}\n`);
    }
  }

  private spawn(streams: readonly DrainStream[], generation: number): SentinelProcess {
    const plan = {
      spoolDir: drainSpoolDir(this.root),
      maxBytes: this.spoolMaxBytes,
      ingestSpoolDir: this.ingestSpoolDir,
      stoppedPath: drainStoppedPath(this.root),
      streams: streams.map((stream, index) => ({ ...stream, fd: FIRST_EXTRA_FD + index })),
    };
    const log = openSync(join(this.root, "drain.log"), "a", 0o600);
    try {
      const proc = Bun.spawn({
        cmd: ["/bin/sh", "-c", SENTINEL_SCRIPT, "sh", generationPath(this.root), String(generation), ...drainCommand(plan)],
        stdio: ["pipe", "ignore", log, ...streams.map((stream) => stream.fd)],
        detached: true,
      });
      proc.unref();
      return proc;
    } finally {
      closeSync(log);
    }
  }
}

function standDown(proc: SentinelProcess): void {
  try {
    proc.stdin.write("stop\n");
    void proc.stdin.end();
  } catch {
    // already gone
  }
}

function readGeneration(root: string): number {
  try {
    const value = Number(readFileSync(generationPath(root), "utf8").trim());
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function recordedSentinels(root: string): number[] {
  try {
    const parsed = JSON.parse(readFileSync(sentinelsPath(root), "utf8")) as { pids?: unknown };
    return Array.isArray(parsed.pids) ? parsed.pids.filter((pid): pid is number => Number.isInteger(pid) && pid > 0) : [];
  } catch {
    return [];
  }
}

/**
 * Stops whatever a previous daemon's sentinels became: a sentinel still
 * waiting to exec, or the drainer it became (same pid). Pids are checked
 * against the stdio root first, since a pid may have been reused. The
 * drainer writes what it read and a stopped marker before it exits. One
 * that does not stop in time is killed.
 */
export async function stopPreviousDrainer(root: string): Promise<void> {
  const signalled: number[] = [];
  for (const pid of recordedSentinels(root)) {
    if (pid === process.pid || !processAlive(pid) || !(await commandLine(pid)).includes(root)) {
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      signalled.push(pid);
    } catch {
      // exited meanwhile
    }
  }
  const running = (): number[] => signalled.filter((pid) => processAlive(pid) && !stoppedBy(root, pid));
  await waitUntil(() => running().length === 0, STOP_WAIT_MS);
  const stuck = running();
  for (const pid of stuck) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // exited meanwhile
    }
  }
  if (stuck.length > 0) {
    await waitUntil(() => stuck.every((pid) => !processAlive(pid)), KILL_WAIT_MS);
  }
}

function stoppedBy(root: string, pid: number): boolean {
  const marker = drainStoppedPath(root);
  try {
    return existsSync(marker) && Number(readFileSync(marker, "utf8").trim()) === pid;
  } catch {
    return false;
  }
}

async function commandLine(pid: number): Promise<string> {
  if (process.platform === "linux") {
    try {
      return parseProcCmdline(await readFile(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return "";
    }
  }
  return captureProcessOutput(["ps", "-p", String(pid), "-o", "command="]);
}

async function waitUntil(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    await sleepMs(STOP_POLL_MS);
  }
}
