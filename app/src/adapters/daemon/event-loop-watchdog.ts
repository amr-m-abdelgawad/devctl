import { readFileSync } from "node:fs";
import { clearInterval as clearWatchInterval, setInterval as setWatchInterval } from "node:timers";
import { readRpcToken, socketPath } from "../storage/storage.ts";
import { resolveWorkerUrl } from "../storage/worker-resolver.ts";
import { claimRestartRequest, heartbeatPath, writeHeartbeatAtomic, type HeartbeatFile } from "./heartbeat.ts";

export const WATCHDOG_TICK_MS = 1_000;
export const WATCHDOG_STALL_TICKS = 20;
export const WATCHDOG_MIN_TICK_GAP_MS = WATCHDOG_TICK_MS / 2;

// True when the worker has kept ticking and the main thread has not posted
// a beat. Sleep freezes both, so a wall-clock gap is not a stall.
export function eventLoopStalled(ticksSinceBeat: number, stallTicks = WATCHDOG_STALL_TICKS): boolean {
  return ticksSinceBeat >= stallTicks;
}

// A resume can deliver a burst of interval callbacks at once. Those must
// count as a single tick, or waking from sleep looks like a stalled loop.
export function watchdogTickAdvanced(elapsedMs: number, minGapMs = WATCHDOG_MIN_TICK_GAP_MS): boolean {
  return elapsedMs >= minGapMs;
}

export type WatchdogHandle = {
  stop: () => void;
  markListening: () => void;
  noteRestartRequest: (onRestart: () => void) => void;
};

export type WatchdogOptions = {
  repoRoot: string;
  session: string;
  identity: string;
};

export function startEventLoopWatchdog(options: WatchdogOptions): WatchdogHandle {
  let stopped = false;
  let listening = false;
  let worker: Worker | undefined;
  let lastBeatAt = Date.now();
  let onRestart: (() => void) | undefined;
  const beat = (): void => {
    const now = Date.now();
    if (!watchdogTickAdvanced(now - lastBeatAt) && listening) {
      return;
    }
    lastBeatAt = now;
    const message = {
      type: listening ? "beat" : "beat",
      repoRoot: options.repoRoot,
      session: options.session,
      identity: options.identity,
      socket: socketPath(options.repoRoot),
      token: readToken(options.repoRoot),
    };
    try {
      worker?.postMessage(listening ? { ...message, type: "listening" } : message);
    } catch {
      worker = undefined;
    }
  };
  const spawnWorker = (): void => {
    if (stopped) {
      return;
    }
    try {
      worker = new Worker(resolveWorkerUrl("event-loop-watchdog-worker", new URL("./event-loop-watchdog-worker.ts", import.meta.url)), { name: "devctl-watchdog" });
      worker.addEventListener("error", (event) => {
        event.stopImmediatePropagation();
        worker = undefined;
        writeDegraded(options);
      });
      beat();
    } catch {
      worker = undefined;
      writeDegraded(options);
    }
  };
  spawnWorker();
  const timer = setWatchInterval(() => {
    if (worker === undefined) {
      writeDegraded(options);
      spawnWorker();
    }
    beat();
    if (claimRestartRequest(options.repoRoot, { pid: process.pid, session: options.session })) {
      onRestart?.();
    }
  }, WATCHDOG_TICK_MS);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearWatchInterval(timer);
      void worker?.terminate();
    },
    markListening: () => {
      listening = true;
      beat();
    },
    noteRestartRequest: (handler) => {
      onRestart = handler;
    },
  };
}

function readToken(repoRoot: string): string {
  try {
    return readRpcToken(repoRoot);
  } catch {
    return "";
  }
}

function writeDegraded(options: WatchdogOptions): void {
  const previous = readPrevious(options.repoRoot);
  const beat: HeartbeatFile = {
    pid: process.pid,
    identity: options.identity,
    session: options.session,
    workerTick: previous?.workerTick ?? 0,
    mainStallTicks: 0,
    rpcOkAgeTicks: previous?.rpcOkAgeTicks ?? 0,
    degraded: true,
    writtenAtMs: Date.now(),
  };
  try {
    writeHeartbeatAtomic(options.repoRoot, beat);
  } catch {
    // a full disk must not look like a frozen daemon
  }
}

function readPrevious(repoRoot: string): HeartbeatFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(heartbeatPath(repoRoot), "utf8")) as HeartbeatFile;
    if (typeof parsed.workerTick === "number") {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
