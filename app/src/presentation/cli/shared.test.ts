import { describe, expect, test } from "bun:test";
import { isStdoutClosed } from "./shared.ts";

describe("isStdoutClosed", () => {
  test("treats POSIX EPIPE and Windows broken-pipe codes as a closed stdout", () => {
    expect(isStdoutClosed({ code: "EPIPE" })).toBe(true);
    expect(isStdoutClosed({ code: "EOF" })).toBe(true);
    expect(isStdoutClosed({ code: "ECONNRESET" })).toBe(true);
    expect(isStdoutClosed({ errno: 109 })).toBe(true);
    expect(isStdoutClosed({ message: "write EPIPE broken pipe" })).toBe(true);
    expect(isStdoutClosed({ code: "EIO" })).toBe(false);
    expect(isStdoutClosed("nope")).toBe(false);
  });
});
