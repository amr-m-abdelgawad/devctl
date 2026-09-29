/**
 * Client decision table for a running daemon. Liveness is not responsiveness:
 * a daemon that is still making progress is never killed.
 */

export const WEDGE_STALL_TICKS = 60;
export const BUSY_RPC_MAX_TICKS = 60;
export const GRACEFUL_RPC_TICKS = 30;
/** A heartbeat newer than this is still being written. Older means the worker is stopped too. */
export const HEARTBEAT_FRESH_MS = 5_000;

export type ProcessLiveness = "alive" | "zombie" | "dead";

export type HeartbeatView = {
  pid: number;
  identity: string;
  session: string;
  workerTick: number;
  mainStallTicks: number;
  rpcOkAgeTicks: number;
  degraded?: boolean;
};

export type LivenessAction =
  | "spawn"
  | "wait-busy"
  | "wait-frozen"
  | "replace-wedge"
  | "graceful-restart"
  | "leave-legacy";

export type LivenessInput = {
  process: ProcessLiveness;
  /** False when start-ticks / boot-id / pid namespace say this is not the lock holder. */
  identityMatches: boolean;
  /** Lock written by this generation (`v: 2`). Older locks have no heartbeat file. */
  lockGeneration: 1 | 2;
  heartbeat?: HeartbeatView;
  /** Undefined when only one sample exists. False means the worker tick did not move. */
  workerAdvanced?: boolean;
};

export function decideLiveness(input: LivenessInput): LivenessAction {
  if (input.process === "dead" || input.process === "zombie" || !input.identityMatches) {
    return "spawn";
  }
  if (input.heartbeat === undefined) {
    return input.lockGeneration === 2 ? "wait-busy" : "leave-legacy";
  }
  if (input.workerAdvanced === false) {
    return "wait-frozen";
  }
  if (input.heartbeat.mainStallTicks >= WEDGE_STALL_TICKS) {
    return "replace-wedge";
  }
  if (input.heartbeat.mainStallTicks === 0 && input.heartbeat.rpcOkAgeTicks > GRACEFUL_RPC_TICKS) {
    return "graceful-restart";
  }
  if (input.heartbeat.rpcOkAgeTicks < BUSY_RPC_MAX_TICKS) {
    return "wait-busy";
  }
  return "wait-busy";
}

export function livenessActionKills(action: LivenessAction): boolean {
  return action === "replace-wedge" || action === "spawn";
}

/**
 * The watchdog worker keeps rewriting the heartbeat while the main thread is wedged.
 * A stale file means the whole process is stopped (SIGSTOP), which must not be killed.
 */
export function heartbeatWorkerAdvanced(
  heartbeat: { writtenAtMs?: number; degraded?: boolean } | undefined,
  nowMs: number,
): boolean | undefined {
  if (heartbeat === undefined) {
    return undefined;
  }
  if (heartbeat.degraded === true) {
    return true;
  }
  const writtenAtMs = heartbeat.writtenAtMs ?? 0;
  if (writtenAtMs <= 0) {
    return false;
  }
  return nowMs - writtenAtMs < HEARTBEAT_FRESH_MS;
}

export const LEGACY_DAEMON_MESSAGE =
  "A daemon left running by an older devctl has no heartbeat and was not replaced. Stop it with `devctl down --force`, then start again.";
