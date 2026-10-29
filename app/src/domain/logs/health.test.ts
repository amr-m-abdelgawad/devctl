import { describe, expect, test } from "bun:test";
import { isHealthCheckLog, isHealthPath } from "./health.ts";
import { logRecord } from "./record.ts";
import { isErrorLevelPreset, matchesSelectedLevels, normalizeLogLevels, toggleListedLevel } from "./severity.ts";
import { LevelError, LevelFatal, LevelInfo, LevelUnknown, LevelWarn } from "./types.ts";
import { matchLog } from "./filter.ts";

describe("isHealthCheckLog", () => {
  test("hides supervisor probes and health-endpoint request lines", () => {
    expect(isHealthCheckLog(logRecord({ source: "health", message: "health HEALTHY 200" }))).toBe(true);
    expect(isHealthCheckLog(logRecord({ source: "stdout", message: "health check still in start period: timeout" }))).toBe(true);
    expect(isHealthCheckLog(logRecord({ message: 'INFO:     127.0.0.1:12345 - "GET /health HTTP/1.1" 200 OK' }))).toBe(true);
    expect(isHealthCheckLog(logRecord({ message: "GET /api/v1/health 200" }))).toBe(true);
    expect(isHealthCheckLog(logRecord({ message: "GET /readyz" }))).toBe(true);
    expect(isHealthCheckLog(logRecord({ message: '[GIN] 2026 | 200 | 1ms | 127.0.0.1 | GET "/healthz"' }))).toBe(true);
    expect(isHealthCheckLog(logRecord({ message: "POST /grpc.health.v1.Health/Check" }))).toBe(true);
    expect(isHealthCheckLog(logRecord({ source: "proxy", message: "GET /health route=api identity= status=200 duration=1ms" }))).toBe(true);
    expect(isHealthCheckLog(logRecord({ source: "proxy", message: "grpc /grpc.health.v1.Health/Check route=api identity= grpc-status=0 duration=1ms" }))).toBe(true);
    expect(isHealthCheckLog(logRecord({
      message: "127.0.0.1 GET http://127.0.0.1:17490/v1/health 200",
      attributes: { api_url: "http://127.0.0.1:17490/v1/health", response_status: 200 },
    }))).toBe(true);
    expect(isHealthCheckLog(logRecord({
      message: "GET /health",
      attributes: { method: "GET", path: "/health", status: 200 },
    }))).toBe(true);
  });

  test("keeps ordinary lines and non-health requests", () => {
    expect(isHealthCheckLog(logRecord({ message: "database health degraded" }))).toBe(false);
    expect(isHealthCheckLog(logRecord({ message: "listening on /health" }))).toBe(false);
    expect(isHealthCheckLog(logRecord({ message: "GET /users/123 200" }))).toBe(false);
    expect(isHealthCheckLog(logRecord({ message: "GET /healthcare 200" }))).toBe(false);
    expect(isHealthCheckLog(logRecord({ message: "GET /live 200" }))).toBe(false);
    expect(isHealthCheckLog(logRecord({ source: "proxy", message: "grpc /temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue route=temporal grpc-status=0 duration=2ms" }))).toBe(false);
    expect(isHealthCheckLog(logRecord({ message: "mounted", attributes: { path: "/health" } }))).toBe(false);
    expect(isHealthPath("/api/v1/health")).toBe(true);
    expect(isHealthPath("/healthcare")).toBe(false);
  });
});

describe("selectable log levels", () => {
  test("normalizes combinations and matches only those buckets", () => {
    expect(normalizeLogLevels("info, warn")).toEqual([LevelInfo, LevelWarn]);
    expect(normalizeLogLevels("warning,err")).toEqual([LevelWarn, LevelError]);
    expect(normalizeLogLevels("all")).toBeUndefined();
    expect(normalizeLogLevels(["INFO", "info"])).toEqual([LevelInfo]);
    expect(matchesSelectedLevels(9, "INFO", [LevelInfo, LevelWarn])).toBe(true);
    expect(matchesSelectedLevels(17, "ERROR", [LevelInfo, LevelWarn])).toBe(false);
    expect(matchesSelectedLevels(0, LevelUnknown, [LevelInfo])).toBe(false);
    expect(matchesSelectedLevels(0, LevelUnknown, [])).toBe(true);
    expect(toggleListedLevel([], "warn")).toEqual([LevelWarn]);
    expect(toggleListedLevel([LevelWarn], "info")).toEqual([LevelInfo, LevelWarn]);
    expect(toggleListedLevel([LevelInfo, LevelWarn], "info")).toEqual([LevelWarn]);
    expect(isErrorLevelPreset([LevelError, LevelFatal])).toBe(true);
    expect(isErrorLevelPreset([LevelError])).toBe(false);
  });

  test("matchLog applies hideHealth and an exact level set", () => {
    const health = logRecord({ source: "health", level: "INFO", message: "health HEALTHY 200" });
    const info = logRecord({ source: "stdout", level: "INFO", message: "ready" });
    const error = logRecord({ source: "stderr", level: "ERROR", message: "boom" });
    expect(matchLog({ hideHealth: true, levels: ["INFO", "WARN"] }, health)).toBe(false);
    expect(matchLog({ hideHealth: true, levels: ["INFO", "WARN"] }, info)).toBe(true);
    expect(matchLog({ hideHealth: true, levels: ["WARN", "ERROR"] }, info)).toBe(false);
    expect(matchLog({ levels: ["WARN", "ERROR"] }, error)).toBe(true);
    expect(matchLog({ level: "ERROR", levels: ["INFO"] }, info)).toBe(true);
  });
});
