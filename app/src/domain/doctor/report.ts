import type { PortHolder } from "../net/ports.ts";
import type { Check, Report } from "./types.ts";

/** Free-all is a second control. One busy port keeps only its own free action. */
export const FREE_ALL_PORT_MINIMUM = 2;

export function portCheckName(port: number): string {
  return `Port ${port}`;
}

// Error rows that name a holder. Healthy "in use by running service" rows have no action.
// Another stack's leftovers are confirmed one at a time, so they stay out of "free all".
export function busyPortHolders(checks: readonly Check[]): PortHolder[] {
  const seen = new Set<number>();
  const holders: PortHolder[] = [];
  for (const check of checks) {
    const holder = check.severity === "error" && check.action?.kind === "free-port" ? check.action.holder : undefined;
    if (holder && holder.stack === undefined && !seen.has(holder.port)) {
      seen.add(holder.port);
      holders.push(holder);
    }
  }
  return holders;
}

// Swap every row for this port and recount issues. Other checks stay as they are.
export function replacePortCheck(report: Report, port: number, next: Check): Report {
  const name = portCheckName(port);
  const checks = report.checks.map((check) => (check.name === name ? next : check));
  const issues = checks.reduce((count, check) => count + (check.severity === "ok" ? 0 : 1), 0);
  return { checks, issues };
}
