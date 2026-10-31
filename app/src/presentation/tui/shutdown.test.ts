import { describe, expect, test } from "bun:test";
import { detachOnSignal, detachOnTermination, formatTuiFailure, signalExitCode } from "./shutdown.ts";

describe("detachOnTermination", () => {
  test("stops services when the preference is unset or true", () => {
    expect(detachOnTermination(undefined)).toBe(false);
    expect(detachOnTermination(true)).toBe(false);
  });

  test("detaches when stop_services_on_exit is false", () => {
    expect(detachOnTermination(false)).toBe(true);
  });

  test("a closed terminal detaches even when the preference is unset", () => {
    expect(detachOnSignal("SIGHUP", undefined)).toBe(true);
    expect(detachOnSignal("SIGHUP", true)).toBe(true);
  });

  test("SIGTERM follows stop_services_on_exit", () => {
    expect(detachOnSignal("SIGTERM", undefined)).toBe(false);
    expect(detachOnSignal("SIGTERM", true)).toBe(false);
    expect(detachOnSignal("SIGTERM", false)).toBe(true);
  });

  test("signal exit status is 128 plus the signal number", () => {
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });
});

describe("formatTuiFailure", () => {
  test("includes an error message", () => {
    expect(formatTuiFailure(new Error("renderer died"))).toContain("renderer died");
  });

  test("stringifies a rejection reason", () => {
    expect(formatTuiFailure("boom")).toBe("boom");
  });
});
