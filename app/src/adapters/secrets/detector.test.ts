import { describe, expect, test } from "bun:test";
import { Detector, REDACTED_VALUE } from "./detector.ts";

describe("secret redaction", () => {
  test("redacts names and bearer tokens", () => {
    const det = new Detector([], []);
    expect(det.redactValue("API_TOKEN", "abc")).toBe(REDACTED_VALUE);
    expect(det.redactValue("LOG_LEVEL", "INFO")).toBe("INFO");
    expect(det.redactText("Authorization: Bearer abc.def")).toBe(`Authorization: Bearer ${REDACTED_VALUE}`);
    expect(det.redactMap({ PASSWORD: "x", NAME: "api" })).toEqual({ PASSWORD: REDACTED_VALUE, NAME: "api" });
  });

  test("redacts raw JWTs and Google tokens without a Bearer prefix", () => {
    const det = new Detector([], []);
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb";
    expect(det.redactText(`upstream id_token=${jwt}`)).toBe(`upstream id_token=${REDACTED_VALUE}`);
    expect(det.redactText(`token ${jwt} trailing`)).toBe(`token ${REDACTED_VALUE} trailing`);
    expect(det.redactText("access_token=ya29.a0ASecretValue")).toBe(`access_token=${REDACTED_VALUE}`);
    expect(det.redactText("minted ya29.a0ASecretValue for iap")).toBe(`minted ${REDACTED_VALUE} for iap`);
    expect(det.redactText("not a token eyJ only")).toBe("not a token eyJ only");
    expect(det.redactText("eyJaaa.bbb")).toBe("eyJaaa.bbb");
    expect(det.redactText(`${jwt} and ${jwt}`)).toBe(`${REDACTED_VALUE} and ${REDACTED_VALUE}`);
    expect(det.redactText(`${"eyJ".repeat(80)}x`)).toBe(`${"eyJ".repeat(80)}x`);
  });
});
