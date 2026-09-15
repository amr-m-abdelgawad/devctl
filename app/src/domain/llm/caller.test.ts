import { describe, expect, test } from "bun:test";
import {
  callerFromCompletionRequest,
  callerFromHeaders,
  callerFromSpendLog,
  isLlmCallerHeader,
  normalizeLlmCaller,
} from "./caller.ts";

describe("LLM caller helpers", () => {
  test("normalizes names and drops emails, blanks, and control characters", () => {
    expect(normalizeLlmCaller(" worker ")).toBe("worker");
    expect(normalizeLlmCaller("dev@example.com")).toBeUndefined();
    expect(normalizeLlmCaller("")).toBeUndefined();
    expect(normalizeLlmCaller("api\nworker")).toBeUndefined();
    expect(normalizeLlmCaller("a".repeat(80))).toHaveLength(64);
  });

  test("reads X-Devctl-Service before the name alias", () => {
    expect(callerFromHeaders({ "X-Devctl-Service": "api" })).toBe("api");
    expect(callerFromHeaders({ "x-devctl-service-name": "worker" })).toBe("worker");
    expect(callerFromHeaders({ "x-devctl-service": "api", "x-devctl-service-name": "other" })).toBe("api");
    expect(callerFromHeaders({ "content-type": "application/json" })).toBeUndefined();
    expect(isLlmCallerHeader("X-Devctl-Service")).toBe(true);
    expect(isLlmCallerHeader("x-devctl-service-name")).toBe(true);
    expect(isLlmCallerHeader("x-devctl-request-id")).toBe(false);
  });

  test("prefers LiteLLM metadata.service over a non-email user", () => {
    expect(callerFromSpendLog({ user: "fallback" }, { service: "worker" })).toBe("worker");
    expect(callerFromSpendLog({ user: "worker" }, {})).toBe("worker");
    expect(callerFromSpendLog({ user: "dev@example.com" }, {})).toBeUndefined();
    expect(callerFromSpendLog({ end_user: "api" }, {})).toBe("api");
  });

  test("reads the OpenAI user field from a completion body", () => {
    expect(callerFromCompletionRequest({ user: "api" })).toBe("api");
    expect(callerFromCompletionRequest({ user: "dev@example.com" })).toBeUndefined();
    expect(callerFromCompletionRequest({ model: "gpt-4o" })).toBeUndefined();
  });
});
