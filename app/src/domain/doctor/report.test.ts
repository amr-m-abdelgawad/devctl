import { describe, expect, test } from "bun:test";
import { replacePortCheck } from "./report.ts";
import type { Report } from "./types.ts";

describe("replacePortCheck", () => {
  test("updates only that port and recounts issues", () => {
    const report: Report = {
      issues: 2,
      checks: [
        { name: "gcloud", severity: "warn", message: "missing" },
        { name: "Port 8080", severity: "error", message: "in use by node (pid 9)", action: { kind: "free-port", holder: { port: 8080, pid: 9, command: "node" } } },
        { name: "Port 9090", severity: "error", message: "in use by other (pid 3)" },
      ],
    };
    const next = replacePortCheck(report, 8080, { name: "Port 8080", severity: "ok", message: "available" });
    expect(next.checks[0]).toEqual(report.checks[0]);
    expect(next.checks[1]).toEqual({ name: "Port 8080", severity: "ok", message: "available" });
    expect(next.checks[2]).toEqual(report.checks[2]);
    expect(next.issues).toBe(2);
  });
});
