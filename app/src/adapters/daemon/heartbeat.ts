import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function writeRestartRequest(repoRoot: string): void {
  const path = restartRequestPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ requestedAtMs: Date.now() })}\n`, { mode: 0o600 });
}
