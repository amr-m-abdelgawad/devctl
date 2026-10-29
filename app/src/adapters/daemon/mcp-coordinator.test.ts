import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { McpHost, McpListener } from "../../ports/mcp-host.ts";
import { MCP_TOKEN_TTL_MS } from "../../shared/mcp-token.ts";
import { mcpTokenPath } from "../storage/storage.ts";
import { McpCoordinator } from "./mcp-coordinator.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "devctl-mcp-coord-"));
}

function fakeListener(): McpListener {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    isRunning: () => false,
    listenPort: () => 0,
    address: () => "",
  };
}

function coordinator(repoRoot: string): McpCoordinator {
  return new McpCoordinator({
    repoRoot: () => repoRoot,
    createListener: () => fakeListener(),
    hostApi: () => ({}) as McpHost,
    isKnownTool: (name) => name === "exec_service" || name === "get_logs",
    log: () => undefined,
    persistState: () => undefined,
  });
}

describe("mcp coordinator tool defaults", () => {
  test("boot disables exec_service when tui.json has no tool lists", async () => {
    const prevHome = process.env.DEVCTL_HOME;
    const dir = tmp();
    process.env.DEVCTL_HOME = dir;
    try {
      const mcp = coordinator(dir);
      await mcp.bootFromPreferences();
      expect(mcp.disabledTools).toEqual(["exec_service"]);
    } finally {
      if (prevHome === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prevHome;
      }
    }
  });

  test("boot keeps exec_service off when another tool was denied", async () => {
    const prevHome = process.env.DEVCTL_HOME;
    const dir = tmp();
    process.env.DEVCTL_HOME = dir;
    writeFileSync(join(dir, "tui.json"), `${JSON.stringify({ mcp_disabled_tools: ["get_logs"] }, null, 2)}\n`);
    try {
      const mcp = coordinator(dir);
      await mcp.bootFromPreferences();
      expect(mcp.disabledTools).toEqual(["exec_service", "get_logs"]);
    } finally {
      if (prevHome === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prevHome;
      }
    }
  });

  test("boot enables exec_service only when it was opted in", async () => {
    const prevHome = process.env.DEVCTL_HOME;
    const dir = tmp();
    process.env.DEVCTL_HOME = dir;
    writeFileSync(join(dir, "tui.json"), `${JSON.stringify({
      mcp_disabled_tools: ["get_logs"],
      mcp_enabled_tools: ["exec_service"],
    }, null, 2)}\n`);
    try {
      const mcp = coordinator(dir);
      await mcp.bootFromPreferences();
      expect(mcp.disabledTools).toEqual(["get_logs"]);
    } finally {
      if (prevHome === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prevHome;
      }
    }
  });
});

describe("mcp coordinator token lifetime", () => {
  test("keeps a saved token unless regeneration is enabled", () => {
    const prevHome = process.env.DEVCTL_HOME;
    const dir = tmp();
    process.env.DEVCTL_HOME = dir;
    try {
      const first = coordinator(dir).token;
      const path = mcpTokenPath(dir);
      const staleSec = (Date.now() - (MCP_TOKEN_TTL_MS + 5_000)) / 1000;
      utimesSync(path, staleSec, staleSec);
      expect(coordinator(dir).token).toBe(first);
      writeFileSync(join(dir, "tui.json"), `${JSON.stringify({ regenerate_session_tokens: true })}\n`);
      expect(coordinator(dir).token).not.toBe(first);
    } finally {
      if (prevHome === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prevHome;
      }
    }
  });
});

describe("mcp coordinator token rotate", () => {
  test("rotate replaces the in-memory bearer token", async () => {
    const prevHome = process.env.DEVCTL_HOME;
    const dir = tmp();
    process.env.DEVCTL_HOME = dir;
    try {
      const mcp = coordinator(dir);
      const first = mcp.token;
      await mcp.rotate();
      expect(mcp.token).not.toBe(first);
      expect(mcp.tokenAgeMs() ?? 999_999).toBeLessThan(5_000);
    } finally {
      if (prevHome === undefined) {
        delete process.env.DEVCTL_HOME;
      } else {
        process.env.DEVCTL_HOME = prevHome;
      }
    }
  });
});
