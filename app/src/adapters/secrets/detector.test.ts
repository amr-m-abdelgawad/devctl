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
});
