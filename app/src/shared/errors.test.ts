import { describe, expect, test } from "bun:test";
import {
  DevctlError,
  ExitAuthn,
  ExitAuthz,
  ExitConfig,
  ExitGeneral,
  ExitHealth,
  ExitProxy,
  ExitStartup,
  exitCode,
  hintError,
  humanMessage,
  isKind,
  KindConfigurationMissing,
  KindGeneral,
  newError,
  parseError,
  serializeError,
  withHint,
  wrapError,
} from "./errors.ts";

describe("typed errors", () => {
  test("maps kinds to exit codes", () => {
    expect(newError("configuration", "bad").exitCode()).toBe(ExitConfig);
    expect(newError(KindConfigurationMissing, "none").exitCode()).toBe(ExitConfig);
    expect(newError("service_not_found", "api").exitCode()).toBe(ExitConfig);
    expect(newError("dependency", "db").exitCode()).toBe(ExitConfig);
    expect(newError("authentication", "no adc").exitCode()).toBe(ExitAuthn);
    expect(newError("token", "expired").exitCode()).toBe(ExitAuthn);
    expect(newError("iap", "denied").exitCode()).toBe(ExitAuthn);
    expect(newError("authorization", "no").exitCode()).toBe(ExitAuthz);
    expect(newError("impersonation", "sa").exitCode()).toBe(ExitAuthz);
    expect(newError("proxy", "bind").exitCode()).toBe(ExitProxy);
    expect(newError("process_start", "failed").exitCode()).toBe(ExitStartup);
    expect(newError("health_check", "down").exitCode()).toBe(ExitHealth);
    expect(newError(KindGeneral, "boom").exitCode()).toBe(ExitGeneral);
    expect(exitCode(new Error("plain"))).toBe(ExitGeneral);
    expect(exitCode(newError("proxy", "bind"))).toBe(ExitProxy);
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

  test("wraps causes, reconstructs strings, and classifies kinds", () => {
    const wrapped = wrapError("process_start", "api failed", new Error("ENOENT"));
    expect(wrapped.causeError?.message).toBe("ENOENT");
    expect(humanMessage(wrapped)).toBe("api failed");
    expect(humanMessage(new Error("plain"))).toBe("plain");
    expect(humanMessage("just text")).toBe("just text");
    expect(isKind(wrapped, "process_start")).toBe(true);
    expect(isKind(new Error("no"), "process_start")).toBe(false);
    const hinted = hintError("general", "clipboard unavailable", "install xclip", "devctl");
    expect(hinted.service).toBe("devctl");
    expect(humanMessage(hinted)).toContain("install xclip");
    expect(parseError("raw string").kind).toBe(KindGeneral);
    expect(parseError({ error: "oops" }).kind).toBe(KindGeneral);
    expect(serializeError(new Error("plain"))).toEqual({ error: "plain" });
  });
});
