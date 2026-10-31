import type { PortHolder } from "../domain/net/ports.ts";
import { humanMessage } from "../shared/errors.ts";

/** One confirmation can stop many holders. Past this, ask for another pass. */
export const MAX_PORTS_FREED_AT_ONCE = 64;

export type PortFreeOutcome = {
  port: number;
  pid: number;
  command: string;
  result?: "stopped" | "already-free";
  error?: string;
};

// A failed port does not cancel the rest. freePort rechecks the holder before each signal.
export async function freePortHolders(
  holders: readonly PortHolder[],
  free: (holder: PortHolder) => Promise<"stopped" | "already-free">,
): Promise<PortFreeOutcome[]> {
  if (holders.length > MAX_PORTS_FREED_AT_ONCE) {
    throw new Error(`Free up to ${MAX_PORTS_FREED_AT_ONCE} ports at once`);
  }
  const outcomes: PortFreeOutcome[] = [];
  for (const holder of holders) {
    outcomes.push(await freeOne(holder, free));
  }
  return outcomes;
}

async function freeOne(
  holder: PortHolder,
  free: (holder: PortHolder) => Promise<"stopped" | "already-free">,
): Promise<PortFreeOutcome> {
  try {
    const result = await free(holder);
    return { port: holder.port, pid: holder.pid, command: holder.command, result };
  } catch (err: unknown) {
    return { port: holder.port, pid: holder.pid, command: holder.command, error: humanMessage(err) };
  }
}

export function describePortFrees(results: readonly PortFreeOutcome[]): string {
  const stopped = results.filter((row) => row.result === "stopped").map((row) => String(row.port));
  const already = results.filter((row) => row.result === "already-free").map((row) => String(row.port));
  const failed = results.filter((row) => row.error);
  const parts: string[] = [];
  if (stopped.length > 0) {
    parts.push(`Stopped ${stopped.join(", ")}`);
  }
  if (already.length > 0) {
    parts.push(`Already free: ${already.join(", ")}`);
  }
  if (failed.length > 0) {
    parts.push(failed.map((row) => `${row.port} was not freed: ${row.error}`).join("; "));
  }
  return parts.join(". ") || "No ports freed";
}
