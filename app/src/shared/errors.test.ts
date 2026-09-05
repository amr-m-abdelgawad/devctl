import { describe, expect, test } from "bun:test";
import { DevctlError, ExitAuthn, ExitConfig, ExitHealth, ExitProxy, ExitStartup, humanMessage, newError, parseError, serializeError, withHint } from "./errors.ts";

describe("typed errors", () => {
  test("maps kinds to exit codes", () => {
    expect(newError("configuration", "bad").exitCode()).toBe(ExitConfig);
    expect(newError("authentication", "no adc").exitCode()).toBe(ExitAuthn);
    expect(newError("proxy", "bind").exitCode()).toBe(ExitProxy);
    expect(newError("process_start", "failed").exitCode()).toBe(ExitStartup);
    expect(newError("health_check", "down").exitCode()).toBe(ExitHealth);
  });

  test("RPC payload reconstructs DevctlError kind", () => {
    const raw = serializeError(newError("process_start", "api failed"));
    const err = parseError(raw);
    expect(err.kind).toBe("process_start");
    expect(err.exitCode()).toBe(ExitStartup);
  });

  test("human message includes hint", () => {
    const err = withHint(newError("authentication", "ADC unavailable"), "run login");
    expect(err).toBeInstanceOf(DevctlError);
    expect(humanMessage(err)).toContain("ADC unavailable");
    expect(humanMessage(err)).toContain("run login");
    expect(humanMessage(err)).toContain(" — ");
  });
});
