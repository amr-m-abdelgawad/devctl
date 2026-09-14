import { describe, expect, test } from "bun:test";
import { formatMcpTokenAge, MCP_TOKEN_TTL_MS } from "./mcp-token.ts";

describe("formatMcpTokenAge", () => {
  test("uses the coarsest unit that is at least one", () => {
    expect(formatMcpTokenAge(30_000)).toBe("<1h");
    expect(formatMcpTokenAge(2 * 60 * 60 * 1000)).toBe("2h");
    expect(formatMcpTokenAge(3 * 24 * 60 * 60 * 1000)).toBe("3d");
  });

  test("TTL is seven days", () => {
    expect(MCP_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
