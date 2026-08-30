import { describe, expect, test } from "bun:test";
import { derivedMcpPort, isDerivedMcpPort, MCP_PORT_BASE, MCP_PORT_MAX } from "./port.ts";

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
});
