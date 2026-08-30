import { describe, expect, test } from "bun:test";
import { MCP_PORT_ROW, MCP_TOGGLE_ROW, mcpHints } from "./Mcp.tsx";

describe("mcp controls", () => {
  test("hints name the highlighted control", () => {
    expect(mcpHints(MCP_TOGGLE_ROW, false).some((h) => h.label === "start server")).toBe(true);
    expect(mcpHints(MCP_TOGGLE_ROW, true).some((h) => h.label === "stop server")).toBe(true);
    expect(mcpHints(MCP_PORT_ROW, false).some((h) => h.label === "change port")).toBe(true);
    expect(mcpHints(MCP_PORT_ROW, false).some((h) => h.label === "apply port")).toBe(true);
    expect(mcpHints(3, true).some((h) => h.label === "copy JSON")).toBe(true);
  });
});
