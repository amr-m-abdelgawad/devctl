import { lockPath } from "../storage/storage.ts";
import { lockHolderSignalable, readLockFile, removeStaleLockFile } from "../storage/lock.ts";
import { isDevctlSupervisor, processState } from "../process/liveness.ts";
import { readHeartbeat, writeRestartRequest } from "./heartbeat.ts";

const REAP_WAIT_MS = 2_000;
const EXIT_POLL_MS = 50;
const WEDGE_TERM_GRACE_MS = 2_000;

/** Signal a lock holder even when it has no heartbeat, once its pid is shown to be that daemon. */
export function forceStopDaemon(repoRoot: string): boolean {
  const path = lockPath(repoRoot);
  const record = readLockFile(path);
  if (record === undefined) {
    return false;
  }
  const state = processState(record.pid);
  if (state !== "alive") {
    // A zombie has stopped already; it only waits for its parent to reap it.
    return state === "zombie";
  }
  if (!lockHolderSignalable(record)) {
    // The pid was reused, or names a process in another PID namespace: do not
    // signal it. A v1 lock has no stamp, so `start` would keep sending the
    // user back here; drop it once its pid is shown to run something else.
    if (record.v !== 2 && isDevctlSupervisor(record.pid) === false) {
      removeStaleLockFile(path, record);
    }
    return false;
  }
  signal(record.pid, "SIGKILL");
  const deadline = Date.now() + REAP_WAIT_MS;
  while (processState(record.pid) === "alive" && Date.now() < deadline) {
    Bun.sleepSync(EXIT_POLL_MS);
  }
  return processState(record.pid) !== "alive";
}

/**
 * Replaces a daemon whose heartbeat shows a wedge: SIGTERM, a short grace,
 * then SIGKILL. The restart request written first makes a daemon that
 * recovers within the grace hand its services over instead of stopping them.
 */
export async function replaceWedgedDaemon(repoRoot: string, graceMs = WEDGE_TERM_GRACE_MS): Promise<void> {
  const record = readLockFile(lockPath(repoRoot));
  if (record === undefined || !lockHolderSignalable(record)) {
    return;
  }
  const heartbeat = readHeartbeat(repoRoot);
  if (heartbeat?.pid === record.pid) {
    writeRestartRequest(repoRoot, { pid: heartbeat.pid, session: heartbeat.session });
  }
  signal(record.pid, "SIGTERM");
  if (await exited(record.pid, graceMs)) {
    return;
  }
  signal(record.pid, "SIGKILL");
  await exited(record.pid, REAP_WAIT_MS);
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // already gone
  }
}

function exited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      const alive = processState(pid) === "alive";
      if (!alive || Date.now() >= deadline) {
        resolve(!alive);
        return;
      }
      setTimeout(tick, EXIT_POLL_MS);
    };
    tick();
  });
}
