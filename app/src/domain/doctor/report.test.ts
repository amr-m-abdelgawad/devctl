import { describe, expect, test } from "bun:test";
import { busyPortHolders, FREE_ALL_PORT_MINIMUM, replacePortCheck } from "./report.ts";
import type { Check, Report } from "./types.ts";

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

describe("busyPortHolders", () => {
  const checks: Check[] = [
    { name: "gcloud", severity: "warn", message: "missing" },
    { name: "Port 8080", severity: "ok", message: "in use by running service api", action: { kind: "free-port", holder: { port: 8080, pid: 1, command: "api" } } },
    { name: "Port 9090", severity: "error", message: "in use by bun (pid 9)", action: { kind: "free-port", holder: { port: 9090, pid: 9, command: "bun" } } },
    { name: "Port 9090", severity: "error", message: "again", action: { kind: "free-port", holder: { port: 9090, pid: 9, command: "bun" } } },
    { name: "Port 7070", severity: "error", message: "already in use" },
    { name: "Port 6060", severity: "error", message: "in use by node (pid 4)", action: { kind: "free-port", holder: { port: 6060, pid: 4, command: "node" } } },
  ];

  test("keeps error holders once, in order, and drops healthy or unnamed ports", () => {
    expect(busyPortHolders(checks)).toEqual([
      { port: 9090, pid: 9, command: "bun" },
      { port: 6060, pid: 4, command: "node" },
    ]);
    expect(FREE_ALL_PORT_MINIMUM).toBe(2);
  });
});
