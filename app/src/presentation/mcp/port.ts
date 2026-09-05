import { KindConfiguration, newError } from "../../shared/errors.ts";
import { available } from "../../adapters/net/ports.ts";
import { repoID } from "../../adapters/storage/storage.ts";

export const MCP_PORT_BASE = 18700;
export const MCP_PORT_SPAN = 600;
export const MCP_PORT_MAX = MCP_PORT_BASE + MCP_PORT_SPAN - 1;
const HEX_PREFIX_LEN = 8;
const WALK_LIMIT = 600;
const MAX_TCP_PORT = 65535;
export const MIN_USER_PORT = 1024;
const MCP_PORT_DIGITS = 5;

export function clampMcpPort(port: number): number {
  if (!Number.isInteger(port)) {
    return MCP_PORT_BASE;
  }
  return Math.min(MAX_TCP_PORT, Math.max(MIN_USER_PORT, port));
}

export function typeMcpPortDigit(draft: string, digit: string): string {
  if (digit.length !== 1 || digit < "0" || digit > "9") {
    return draft;
  }
  if (draft.length >= MCP_PORT_DIGITS) {
    return digit;
  }
  return `${draft}${digit}`;
}

export function backspaceMcpPortDraft(draft: string): string {
  return draft.slice(0, -1);
}

export function commitMcpPortDraft(draft: string, fallback: number): number {
  if (draft === "") {
    return clampMcpPort(fallback);
  }
  const parsed = Number(draft);
  if (!Number.isInteger(parsed)) {
    return clampMcpPort(fallback);
  }
  return clampMcpPort(parsed);
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
