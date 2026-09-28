/**
 * Client decision table for a running daemon. Liveness is not responsiveness:
 * a daemon that is still making progress is never killed.
 */

export const WEDGE_STALL_TICKS = 60;
export const BUSY_RPC_MAX_TICKS = 60;
export const GRACEFUL_RPC_TICKS = 30;

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

export const LEGACY_DAEMON_MESSAGE =
  "A daemon left running by an older devctl has no heartbeat and was not replaced. Stop it with `devctl down --force`, then start again.";
