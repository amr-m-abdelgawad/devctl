import { describe, expect, test } from "bun:test";
import { systemErrorCode, withErrorCode } from "./error-code.ts";

describe("systemErrorCode", () => {
  test("reads a Node-style errno code", () => {
    expect(systemErrorCode({ code: "EADDRINUSE" })).toBe("EADDRINUSE");
  });

  test("returns empty when the value has no string code", () => {
    expect(systemErrorCode(undefined)).toBe("");
    expect(systemErrorCode("EADDRINUSE")).toBe("");
    expect(systemErrorCode({ code: 48 })).toBe("");
    expect(systemErrorCode({})).toBe("");
  });
});

describe("withErrorCode", () => {
  test("appends the code so bind failures stay visible after cause stripping", () => {
    expect(withErrorCode("unable to listen on 127.0.0.1:18418", { code: "EADDRINUSE" })).toBe(
      "unable to listen on 127.0.0.1:18418 (EADDRINUSE)",
    );
  });

  test("leaves the message unchanged when there is no code", () => {
    expect(withErrorCode("unable to listen on 127.0.0.1:18418", new Error("boom"))).toBe(
      "unable to listen on 127.0.0.1:18418",
    );
  });
});
