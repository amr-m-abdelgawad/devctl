import { describe, expect, test } from "bun:test";
import { Detector, REDACTED_VALUE } from "./detector.ts";

const JWT = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("secret redaction", () => {
  test("redacts credential names and credential-shaped bearer tokens", () => {
    const det = new Detector([], []);
    expect(det.redactValue("API_TOKEN", "abc")).toBe(REDACTED_VALUE);
    expect(det.redactValue("LOG_LEVEL", "INFO")).toBe("INFO");
    expect(det.redactText("Authorization: Bearer abc.def")).toBe("Authorization: Bearer abc.def");
    expect(det.redactText(`Authorization: Bearer ${JWT}`)).toBe(`Authorization: Bearer ${REDACTED_VALUE}`);
    expect(det.redactText('WWW-Authenticate: Bearer realm="https://accounts.google.com/"')).toBe('WWW-Authenticate: Bearer realm="https://accounts.google.com/"');
    expect(det.redactText("the bearer of bad news")).toBe("the bearer of bad news");
    expect(det.redactMap({ PASSWORD: "x", NAME: "api" })).toEqual({ PASSWORD: REDACTED_VALUE, NAME: "api" });
  });

  test("does not treat metadata or usage keys as secret names", () => {
    const det = new Detector([], []);
    expect(det.redactValue("prompt_tokens", "12")).toBe("12");
    expect(det.redactValue("completion_tokens", "4")).toBe("4");
    expect(det.redactValue("total_tokens", "16")).toBe("16");
    expect(det.redactValue("max_tokens", "256")).toBe("256");
    expect(det.redactValue("input_tokens", "8")).toBe("8");
    expect(det.redactValue("output_tokens", "3")).toBe("3");
    expect(det.redactValue("max_completion_tokens", "64")).toBe("64");
    expect(det.redactValue("access_token", "abc")).toBe(REDACTED_VALUE);
    expect(det.redactValue("id_token", "abc")).toBe(REDACTED_VALUE);
    expect(det.redactValue("TOKEN", "abc")).toBe("abc");
    expect(det.redactValue("TOKEN", "super-secret-token-value")).toBe(REDACTED_VALUE);
    expect(det.redactValue("token_type", "Bearer")).toBe("Bearer");
    expect(det.redactValue("page_token", "cursor-1")).toBe("cursor-1");
    expect(det.redactValue("DEVCTL_TOKEN_URL", "http://127.0.0.1:9/token")).toBe("http://127.0.0.1:9/token");
    expect(det.redactValue("DEVCTL_INTERNAL_TOKEN", "abc")).toBe(REDACTED_VALUE);
  });

  test("redacts raw JWTs and Google tokens without a Bearer prefix", () => {
    const det = new Detector([], []);
    expect(det.redactText(`upstream id_token=${JWT}`)).toBe(`upstream id_token=${REDACTED_VALUE}`);
    expect(det.redactText(`token ${JWT} trailing`)).toBe(`token ${REDACTED_VALUE} trailing`);
    expect(det.redactText("access_token=ya29.a0ASecretValue")).toBe(`access_token=${REDACTED_VALUE}`);
    expect(det.redactText("minted ya29.a0ASecretValue for iap")).toBe(`minted ${REDACTED_VALUE} for iap`);
    expect(det.redactText("not a token eyJ only")).toBe("not a token eyJ only");
    expect(det.redactText("eyJaaa.bbb")).toBe("eyJaaa.bbb");
    expect(det.redactText("eyJa.b.c")).toBe("eyJa.b.c");
    expect(det.redactText("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb")).toBe("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb");
    expect(det.redactText(`${JWT} and ${JWT}`)).toBe(`${REDACTED_VALUE} and ${REDACTED_VALUE}`);
    expect(det.redactText(`${"eyJ".repeat(80)}x`)).toBe(`${"eyJ".repeat(80)}x`);
  });

  test("secrets.redact false leaves values unchanged until turned back on", () => {
    const det = new Detector([], [], false);
    expect(det.redacts).toBe(false);
    expect(det.redactValue("API_TOKEN", "abc")).toBe("abc");
    expect(det.redactText(`Authorization: Bearer ${JWT}`)).toContain(JWT);
    det.update([], []);
    expect(det.redactValue("PASSWORD", "x")).toBe("x");
    det.update([], [], true);
    expect(det.redactValue("PASSWORD", "x")).toBe(REDACTED_VALUE);
  });
});
