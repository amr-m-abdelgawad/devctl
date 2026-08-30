import { KindConfiguration, newError } from "../errors.ts";
import { available } from "../ports.ts";
import { repoID } from "../storage.ts";

export const MCP_PORT_BASE = 18700;
export const MCP_PORT_SPAN = 600;
export const MCP_PORT_MAX = MCP_PORT_BASE + MCP_PORT_SPAN - 1;
const HEX_PREFIX_LEN = 8;
const WALK_LIMIT = 600;
const MAX_TCP_PORT = 65535;
export const MIN_USER_PORT = 1024;

export function clampMcpPort(port: number): number {
  if (!Number.isInteger(port)) {
    return MCP_PORT_BASE;
  }
  return Math.min(MAX_TCP_PORT, Math.max(MIN_USER_PORT, port));
}

export function derivedMcpPort(repoRoot: string): number {
  const n = Number.parseInt(repoID(repoRoot).slice(0, HEX_PREFIX_LEN), 16);
  const offset = Number.isFinite(n) ? n % MCP_PORT_SPAN : 0;
  return MCP_PORT_BASE + offset;
}

export function isDerivedMcpPort(repoRoot: string, port: number): boolean {
  return port === derivedMcpPort(repoRoot);
}

export async function resolveMcpPort(repoRoot: string, override?: number): Promise<number> {
  const preferred = Number.isInteger(override) && (override ?? 0) > 0 ? (override as number) : derivedMcpPort(repoRoot);
  for (let step = 0; step < WALK_LIMIT; step += 1) {
    const port = preferred + step;
    if (port > MAX_TCP_PORT) {
      break;
    }
    if (await available(port)) {
      return port;
    }
  }
  throw newError(KindConfiguration, `no free MCP port starting at ${preferred}`);
}
