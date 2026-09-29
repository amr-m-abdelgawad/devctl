import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HeartbeatView } from "../../domain/daemon/liveness.ts";
import { lockPath } from "../storage/storage.ts";

export type HeartbeatFile = HeartbeatView & {
  writtenAtMs: number;
  degraded?: boolean;
};

export function daemonStateDir(repoRoot: string): string {
  return dirname(lockPath(repoRoot));
}

export function heartbeatPath(repoRoot: string): string {
  return join(daemonStateDir(repoRoot), "heartbeat.json");
}

export function restartRequestPath(repoRoot: string): string {
  return join(daemonStateDir(repoRoot), "restart.request");
}

export function wedgePath(repoRoot: string): string {
  return join(daemonStateDir(repoRoot), "wedge");
}

export function readHeartbeat(repoRoot: string): HeartbeatFile | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(heartbeatPath(repoRoot), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const row = parsed as Partial<HeartbeatFile>;
    if (typeof row.pid !== "number" || typeof row.workerTick !== "number" || typeof row.mainStallTicks !== "number" || typeof row.rpcOkAgeTicks !== "number") {
      return undefined;
    }
    return {
      pid: row.pid,
      identity: typeof row.identity === "string" ? row.identity : "",
      session: typeof row.session === "string" ? row.session : "",
      workerTick: row.workerTick,
      mainStallTicks: row.mainStallTicks,
      rpcOkAgeTicks: row.rpcOkAgeTicks,
      degraded: row.degraded === true,
      writtenAtMs: typeof row.writtenAtMs === "number" ? row.writtenAtMs : 0,
    };
  } catch {
    return undefined;
  }
}

export function writeHeartbeatAtomic(repoRoot: string, beat: HeartbeatFile): void {
  const path = heartbeatPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(beat)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The daemon a graceful restart is meant for. A request for any other daemon is stale. */
export type RestartTarget = {
  pid: number;
  session: string;
};

export function writeRestartRequest(repoRoot: string, target?: RestartTarget): void {
  const path = restartRequestPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ requestedAtMs: Date.now(), ...target })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Takes the pending restart request when it is addressed to `self`. A request
 * for another daemon, or one with no target, was left by a daemon that is gone,
 * so it is deleted instead of acted on. Claiming renames the file first, so
 * the request is acted on at most once even if two ticks race.
 */
export function claimRestartRequest(repoRoot: string, self: RestartTarget): boolean {
  const path = restartRequestPath(repoRoot);
  let request: Partial<RestartTarget> | undefined;
  try {
    request = JSON.parse(readFileSync(path, "utf8")) as Partial<RestartTarget>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    request = undefined;
  }
  const addressed = request?.pid === self.pid && (request.session === undefined || request.session === self.session);
  const claimed = `${path}.claimed.${process.pid}`;
  try {
    renameSync(path, claimed);
  } catch {
    return false;
  }
  removeQuiet(claimed);
  return addressed;
}

/** A new daemon cannot be the target of a request written before it started. */
export function clearRestartRequest(repoRoot: string): void {
  removeQuiet(restartRequestPath(repoRoot));
}

function removeQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}
