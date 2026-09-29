import { lockPath } from "../storage/storage.ts";
import { lockHolderSignalable, readLockFile, removeStaleLockFile } from "../storage/lock.ts";
import { isDevctlSupervisor, processState } from "../process/liveness.ts";

const REAP_WAIT_MS = 2_000;

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
  try {
    process.kill(record.pid, "SIGKILL");
  } catch {
    // already gone
  }
  const deadline = Date.now() + REAP_WAIT_MS;
  while (processState(record.pid) === "alive" && Date.now() < deadline) {
    Bun.sleepSync(50);
  }
  return processState(record.pid) !== "alive";
}
