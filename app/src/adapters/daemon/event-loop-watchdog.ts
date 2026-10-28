import { readFileSync } from "node:fs";
import { clearInterval as clearWatchInterval, setInterval as setWatchInterval } from "node:timers";
import { readRpcToken, socketPath } from "../storage/storage.ts";
import { resolveWorkerUrl } from "../storage/worker-resolver.ts";
import { claimRestartRequest, heartbeatPath, writeHeartbeatAtomic, type HeartbeatFile } from "./heartbeat.ts";
import { noteWatchdog } from "./resource-probe.ts";

export const WATCHDOG_TICK_MS = 1_000;
export const WATCHDOG_STALL_TICKS = 20;
export const WATCHDOG_MIN_TICK_GAP_MS = WATCHDOG_TICK_MS / 2;
export const WATCHDOG_RESPAWN_MAX_TICKS = 60;

// Ticks to wait before respawning a worker that has failed `failures` times
// in a row: one, doubling, capped at a minute. A worker that cannot load (a
// broken install) must not be rebuilt every second.
export function watchdogRespawnTicks(failures: number): number {
  return Math.min(WATCHDOG_RESPAWN_MAX_TICKS, 2 ** Math.max(0, failures - 1));
}

// Consecutive failures once a worker dies after `upMs`. One that stayed up
// for the whole cap was healthy, so its crash starts a new series; one that
// opened and crashed at once keeps backing off.
export function watchdogFailures(previous: number, upMs: number): number {
  return upMs >= WATCHDOG_RESPAWN_MAX_TICKS * WATCHDOG_TICK_MS ? 1 : previous + 1;
}

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
  /** Tests point this at a worker that fails. */
  script?: URL;
};

export function startEventLoopWatchdog(options: WatchdogOptions): WatchdogHandle {
  let stopped = false;
  let listening = false;
  let worker: Worker | undefined;
  let lastBeatAt = Date.now();
  let onRestart: (() => void) | undefined;
  let failures = 0;
  let spawnedAt = 0;
  let respawnTicks = 0;
  const script = options.script ?? resolveWorkerUrl("event-loop-watchdog-worker", new URL("./event-loop-watchdog-worker.ts", import.meta.url));
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
      fail();
    }
  };
  // Every way the worker goes away lands here. The degraded heartbeat is
  // written at once, so a client never mistakes the silence for a paused
  // daemon, and the next spawn waits out the backoff.
  const fail = (): void => {
    const failed = worker;
    worker = undefined;
    void failed?.terminate();
    if (stopped) {
      return;
    }
    failures = watchdogFailures(failures, Date.now() - spawnedAt);
    respawnTicks = watchdogRespawnTicks(failures);
    noteWatchdog("degraded");
    writeDegraded(options);
  };
  const spawnWorker = (): void => {
    if (stopped) {
      return;
    }
    spawnedAt = Date.now();
    let spawned: Worker;
    try {
      spawned = new Worker(script, { name: "devctl-watchdog" });
    } catch {
      fail();
      return;
    }
    worker = spawned;
    spawned.addEventListener("open", () => {
      if (worker === spawned) {
        noteWatchdog("ok");
      }
    });
    spawned.addEventListener("error", (event) => {
      event.stopImmediatePropagation();
      if (worker === spawned) {
        fail();
      }
    });
    beat();
  };
  spawnWorker();
  const timer = setWatchInterval(() => {
    if (worker === undefined) {
      respawnTicks -= 1;
      if (respawnTicks <= 0) {
        spawnWorker();
      }
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
