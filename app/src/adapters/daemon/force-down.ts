import { killRepoSupervisor, lockPath, processAlive, readRepoLock } from "../storage/storage.ts";
import { lockIsLive, readLockFile } from "../storage/lock.ts";
import { processState } from "../process/liveness.ts";

const REAP_WAIT_MS = 2_000;

/** Signal a lock holder even when it has no heartbeat. Verifies v2 identity before signalling. */
export function forceStopDaemon(repoRoot: string): boolean {
  const record = readLockFile(lockPath(repoRoot));
  const brief = readRepoLock(repoRoot);
  const pid = record?.pid ?? brief?.pid;
  if (pid === undefined || processState(pid) === "dead") {
    return false;
  }
  if (record?.v === 2 && !lockIsLive(record) && processState(pid) === "alive") {
    // Pid was reused. Do not signal the new process.
    return false;
  }
  if (!processAlive(pid) && processState(pid) !== "zombie") {
    return false;
  }
  killRepoSupervisor(repoRoot);
  const deadline = Date.now() + REAP_WAIT_MS;
  while (processState(pid) === "alive" && Date.now() < deadline) {
    Bun.sleepSync(50);
  }
  return processState(pid) !== "alive";
}
