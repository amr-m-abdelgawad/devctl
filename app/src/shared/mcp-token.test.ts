import { describe, expect, test } from "bun:test";
import { formatMcpTokenAge, formatSessionTokenAge, MCP_TOKEN_TTL_MS, sessionTokenTtlMs } from "./mcp-token.ts";

describe("formatMcpTokenAge", () => {
  test("uses the coarsest unit that is at least one", () => {
    expect(formatMcpTokenAge(30_000)).toBe("<1h");
    expect(formatMcpTokenAge(2 * 60 * 60 * 1000)).toBe("2h");
    expect(formatMcpTokenAge(3 * 24 * 60 * 60 * 1000)).toBe("3d");
  });

  test("TTL is seven days and regeneration is off unless asked", () => {
    expect(MCP_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(sessionTokenTtlMs(false)).toBe(Number.POSITIVE_INFINITY);
    expect(sessionTokenTtlMs(true)).toBe(MCP_TOKEN_TTL_MS);
  });

  test("labels a kept token separately from one that expires", () => {
    expect(formatSessionTokenAge(3 * 24 * 60 * 60 * 1000, false)).toBe("3d · kept");
    expect(formatSessionTokenAge(3 * 24 * 60 * 60 * 1000, true)).toBe("3d / 7d");
  });
});
