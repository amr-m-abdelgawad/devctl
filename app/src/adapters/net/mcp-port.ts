import { KindConfiguration, newError } from "../../shared/errors.ts";
import { available } from "./ports.ts";
import { derivedMcpPort } from "../../domain/net/mcp-port.ts";
const WALK_LIMIT = 600;
const MAX_TCP_PORT = 65535;

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
