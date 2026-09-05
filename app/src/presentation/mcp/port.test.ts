import { describe, expect, test } from "bun:test";
import { commitMcpPortDraft, derivedMcpPort, isDerivedMcpPort, MCP_PORT_BASE, MCP_PORT_MAX, MIN_USER_PORT, typeMcpPortDigit } from "./port.ts";

describe("mcp port", () => {
  test("is stable per repo and stays in 18700–19299", () => {
    const a = derivedMcpPort("/repos/alpha");
    const b = derivedMcpPort("/repos/alpha");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(MCP_PORT_BASE);
    expect(a).toBeLessThanOrEqual(MCP_PORT_MAX);
    expect(isDerivedMcpPort("/repos/alpha", a)).toBe(true);
    expect(isDerivedMcpPort("/repos/alpha", a + 1)).toBe(false);
  });

  test("different roots can land on different ports", () => {
    const ports = ["/a", "/b", "/c", "/d"].map((root) => derivedMcpPort(root));
    expect(ports.every((port) => port >= MCP_PORT_BASE && port <= MCP_PORT_MAX)).toBe(true);
  });

  test("typed digits stay unclamped until commit", () => {
    let draft = "";
    for (const digit of "8080") {
      draft = typeMcpPortDigit(draft, digit);
    }
    expect(draft).toBe("8080");
    expect(commitMcpPortDraft("8", 18700)).toBe(MIN_USER_PORT);
    expect(commitMcpPortDraft("8080", 18700)).toBe(8080);
    expect(commitMcpPortDraft("3", 18700)).toBe(MIN_USER_PORT);
  });
});
