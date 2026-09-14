import { describe, expect, test } from "bun:test";
import { headerValue } from "./headers.ts";

describe("headerValue", () => {
  test("takes the first comma-separated value and trims it", () => {
    expect(headerValue("  127.0.0.1:18900  ")).toBe("127.0.0.1:18900");
    expect(headerValue("a, b")).toBe("a");
    expect(headerValue(["Bearer tok", "other"])).toBe("Bearer tok");
    expect(headerValue(undefined)).toBe("");
  });
});
