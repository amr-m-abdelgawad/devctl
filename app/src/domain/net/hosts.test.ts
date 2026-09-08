import { describe, expect, test } from "bun:test";
import { isLoopbackBindHost } from "./hosts.ts";

describe("isLoopbackBindHost", () => {
  test("allows loopback and empty (caller default)", () => {
    expect(isLoopbackBindHost("")).toBe(true);
    expect(isLoopbackBindHost("localhost")).toBe(true);
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("127.0.0.2")).toBe(true);
    expect(isLoopbackBindHost("::1")).toBe(true);
    expect(isLoopbackBindHost("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects unspecified and non-loopback binds", () => {
    expect(isLoopbackBindHost("0.0.0.0")).toBe(false);
    expect(isLoopbackBindHost("::")).toBe(false);
    expect(isLoopbackBindHost("::0")).toBe(false);
    expect(isLoopbackBindHost("::ffff:0.0.0.0")).toBe(false);
    expect(isLoopbackBindHost("192.168.1.1")).toBe(false);
    expect(isLoopbackBindHost("*")).toBe(false);
  });
});
