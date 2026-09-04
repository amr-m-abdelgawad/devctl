import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrEmpty } from "../config/index.ts";
import { Supervisor } from "../supervisor.ts";
import { MCP_TOOL_CATEGORIES, MCP_TOOLS, enabledTools, isKnownToolName, toolEnabled } from "./tools.ts";
import {
  mcpFirstSnippetRow,
  mcpRowCount,
  mcpSnippetIndexAtRow,
  mcpToolAtRow,
  mcpToolRows,
  MCP_FIRST_TOOL,
  MCP_SNIPPET_COUNT,
  mcpHints,
} from "../tui/screens/Mcp.tsx";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "devctl-toolgate-"));
}

function newSupervisor(): Supervisor {
  const cfg = loadOrEmpty(tmp(), "");
  cfg.logs.persistence.enabled = false;
  return new Supervisor(cfg, {
    detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
  });
}

describe("tool metadata", () => {
  test("every tool carries the fields the TUI renders", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.summary.length).toBeGreaterThan(0);
      expect(MCP_TOOL_CATEGORIES).toContain(tool.category);
      // The long agent-facing description must not double as the short one.
      expect(tool.summary).not.toBe(tool.description);
    }
  });

  test("exactly the state-changing tools are marked as mutating", () => {
    const mutating = MCP_TOOLS.filter((t) => t.mutates).map((t) => t.name).sort();
    expect(mutating).toEqual(["exec_service", "reload_config", "restart_services", "start_services", "stop_services"]);
  });
});

describe("enable / disable", () => {
  test("defaults to every tool on", () => {
    expect(enabledTools(undefined)).toHaveLength(MCP_TOOLS.length);
    expect(enabledTools([])).toHaveLength(MCP_TOOLS.length);
  });

  test("a deny-list hides only what it names", () => {
    const left = enabledTools(["get_logs", "run_doctor"]).map((t) => t.name);
    expect(left).not.toContain("get_logs");
    expect(left).not.toContain("run_doctor");
    expect(left).toContain("list_services");
    expect(left).toHaveLength(MCP_TOOLS.length - 2);
  });

  // The reason it is a deny-list rather than an allow-list: a saved list
  // written by an older version must not disable a tool added later.
  test("a tool the saved list has never heard of is still enabled", () => {
    expect(toolEnabled("a_tool_added_next_year", ["get_logs"])).toBe(true);
  });
});

describe("supervisor tool gate", () => {
  test("stores, sorts and de-duplicates the deny-list", () => {
    const sup = newSupervisor();
    sup.setMcpDisabledTools(["run_doctor", "get_logs", "get_logs"]);
    expect(sup.snapshot().mcp?.disabled_tools).toEqual(["get_logs", "run_doctor"]);
  });

  test("drops names that are not tools instead of storing them forever", () => {
    const sup = newSupervisor();
    sup.setMcpDisabledTools(["get_logs", "tool_from_a_previous_version"]);
    expect(sup.snapshot().mcp?.disabled_tools).toEqual(["get_logs"]);
  });

  test("an empty list turns everything back on", () => {
    const sup = newSupervisor();
    sup.setMcpDisabledTools(["get_logs"]);
    sup.setMcpDisabledTools([]);
    expect(sup.snapshot().mcp?.disabled_tools).toEqual([]);
  });

  // The security property: mcp_set_tools lives in the local socket dispatch
  // and is deliberately absent from McpHost, so a connected agent cannot
  // re-enable a tool its operator turned off. If someone ever adds it to the
  // host API, this fails and they have to justify it.
  test("the host surface an agent sees cannot change the deny-list", () => {
    const sup = newSupervisor();
    const host = (sup as unknown as { asMcpHost: () => Record<string, unknown> }).asMcpHost();
    for (const key of Object.keys(host)) {
      expect(key).not.toMatch(/tool/i);
    }
    expect(Object.keys(host)).not.toContain("setMcpDisabledTools");
  });
});

describe("mcp screen rows", () => {
  test("every tool gets exactly one row, between the controls and the snippets", () => {
    expect(mcpToolRows()).toHaveLength(MCP_TOOLS.length);
    expect(mcpFirstSnippetRow()).toBe(MCP_FIRST_TOOL + MCP_TOOLS.length);
    expect(mcpRowCount()).toBe(MCP_FIRST_TOOL + MCP_TOOLS.length + MCP_SNIPPET_COUNT);
    expect(new Set(mcpToolRows().map((t) => t.name)).size).toBe(MCP_TOOLS.length);
  });

  test("rows are grouped by category in the declared order", () => {
    const order = mcpToolRows().map((t) => MCP_TOOL_CATEGORIES.indexOf(t.category));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  // The invariant that survives reordering: every row is exactly one kind of
  // thing. Tools moved above the snippets, so the snippet offset is derived —
  // an overlap here is what would make `space` toggle a tool and copy a
  // snippet, or silently do nothing.
  test("each row is a control, a tool, or a snippet — never two of them", () => {
    for (let row = 0; row < mcpRowCount(); row += 1) {
      const tool = mcpToolAtRow(row);
      const snippet = mcpSnippetIndexAtRow(row);
      const isControl = row < MCP_FIRST_TOOL;
      expect([isControl, tool !== undefined, snippet !== undefined].filter(Boolean)).toHaveLength(1);
      if (tool) {
        expect(isKnownToolName(tool.name)).toBe(true);
      }
    }
    expect(mcpToolAtRow(mcpRowCount())).toBeUndefined();
    expect(mcpSnippetIndexAtRow(mcpRowCount())).toBeUndefined();
  });

  test("the four snippet rows come last and map to snippet indexes 0-3", () => {
    const indexes = [];
    for (let row = mcpFirstSnippetRow(); row < mcpRowCount(); row += 1) {
      indexes.push(mcpSnippetIndexAtRow(row));
    }
    expect(indexes).toEqual([0, 1, 2, 3]);
  });
});

describe("mcp footer hints", () => {
  // Snippet rows now sit above MCP_FIRST_TOOL numerically, so a hint rule
  // written as a lower bound would tell the user that "space" enables or
  // disables a tool while they are standing on a Copy row.
  test("each row kind gets its own hints", () => {
    const keys = (row: number): string[] => mcpHints(row, true).map((h) => h.label);
    expect(keys(MCP_FIRST_TOOL)).toContain("enable / disable");
    expect(keys(mcpFirstSnippetRow())).toContain("copy JSON");
    expect(keys(mcpFirstSnippetRow())).not.toContain("enable / disable");
    expect(keys(mcpRowCount() - 1)).not.toContain("enable / disable");
    expect(keys(0)).toContain("stop server");
    expect(keys(1)).toContain("change port");
  });
});
