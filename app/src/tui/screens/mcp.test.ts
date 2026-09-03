import { describe, expect, test } from "bun:test";
import { mcpFirstSnippetRow, MCP_FIRST_TOOL, MCP_PORT_ROW, MCP_TOGGLE_ROW, mcpHints } from "./Mcp.tsx";

describe("mcp controls", () => {
  test("hints name the highlighted control", () => {
    expect(mcpHints(MCP_TOGGLE_ROW, false).some((h) => h.label === "start server")).toBe(true);
    expect(mcpHints(MCP_TOGGLE_ROW, true).some((h) => h.label === "stop server")).toBe(true);
    expect(mcpHints(MCP_PORT_ROW, false).some((h) => h.label === "change port")).toBe(true);
    expect(mcpHints(MCP_PORT_ROW, false).some((h) => h.label === "apply port")).toBe(true);
    // Derived, not a literal row: tool rows sit between the controls and the
    // snippets, so a hardcoded index silently changes meaning when a tool is
    // added or the sections are reordered.
    expect(mcpHints(mcpFirstSnippetRow(), true).some((h) => h.label === "copy JSON")).toBe(true);
    expect(mcpHints(MCP_FIRST_TOOL, true).some((h) => h.label === "enable / disable")).toBe(true);
  });
});
