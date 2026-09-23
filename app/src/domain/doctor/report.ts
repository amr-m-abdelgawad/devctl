import type { Check, Report } from "./types.ts";

export function portCheckName(port: number): string {
  return `Port ${port}`;
}

// Swap every row for this port and recount issues. Other checks stay as they are.
export function replacePortCheck(report: Report, port: number, next: Check): Report {
  const name = portCheckName(port);
  const checks = report.checks.map((check) => (check.name === name ? next : check));
  const issues = checks.reduce((count, check) => count + (check.severity === "ok" ? 0 : 1), 0);
  return { checks, issues };
}
