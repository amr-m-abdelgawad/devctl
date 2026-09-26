import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, test } from "bun:test";
import type { ClientRuntime, Controller } from "../../application/client-runtime.ts";
import { addMcp } from "./listeners.ts";

function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

describe("devctl mcp --rotate", () => {
  test("rotates the on-disk token when no daemon is attached", async () => {
    let rotated = "";
    const runtime = {
      openController: async () =>
        ({
          client: undefined,
          cfg: { repoRoot: "/repo", ui: { keymap: {} }, instance: { name: "", slot: 0, portOffset: 0 } },
          close: async () => {},
        }) as unknown as Controller,
      rotateMcpToken: (repoRoot: string) => {
        rotated = repoRoot;
        return "new-token";
      },
      mcpTokenAgeMs: () => 0,
      loadTuiConfig: () => ({ mcp_port: undefined }),
    } as unknown as ClientRuntime;
    const root = new Command();
    root.option("-c, --config <path>");
    addMcp(root, runtime);
    const cap = captureStdout();
    try {
      await root.parseAsync(["node", "devctl", "mcp", "--rotate"], { from: "node" });
    } finally {
      cap.restore();
    }
    expect(rotated).toBe("/repo");
    expect(cap.output()).toContain("token age");
    expect(cap.output()).toContain("new-token");
  });
});

describe("devctl mcp --write", () => {
  function runtimeWith(files: Map<string, string>, token: string) {
    return {
      openController: async () =>
        ({
          client: {},
          cfg: { repoRoot: "/wt", ui: { keymap: {} }, instance: { name: "", slot: 1, portOffset: 100 } },
          status: async () => ({ mcp: token === "" ? { running: false } : { running: true, port: 18801, address: "http://127.0.0.1:18801/mcp", token } }),
          close: async () => {},
        }) as unknown as Controller,
      mcpTokenAgeMs: () => 0,
      loadTuiConfig: () => ({ mcp_port: undefined }),
      fileExists: (path: string) => files.has(path),
      readTextFile: (path: string) => files.get(path) ?? "",
      writeSecretFile: (path: string, text: string) => files.set(path, text),
    } as unknown as ClientRuntime;
  }

  async function run(runtime: ClientRuntime, ...args: string[]): Promise<string> {
    const root = new Command();
    root.option("-c, --config <path>");
    addMcp(root, runtime);
    const cap = captureStdout();
    try {
      await root.parseAsync(["node", "devctl", "mcp", ...args], { from: "node" });
    } finally {
      cap.restore();
    }
    return cap.output();
  }

  test("writes the stack's URL and token into the checkout's client config", async () => {
    // The command joins the checkout and file with path.join (\wt\.mcp.json on Windows).
    const path = join("/wt", ".mcp.json");
    const files = new Map([[path, JSON.stringify({ mcpServers: { other: { url: "x" } } })]]);
    const out = await run(runtimeWith(files, "tok"), "--write", "claude");
    expect(out).toContain("wrote .mcp.json: devctl -> http://127.0.0.1:18801/mcp");
    expect(JSON.parse(files.get(path) ?? "")).toEqual({
      mcpServers: { other: { url: "x" }, devctl: { type: "http", url: "http://127.0.0.1:18801/mcp", headers: { Authorization: "Bearer tok" } } },
    });
  });

  test("refuses without a running listener, and for codex", async () => {
    await expect(run(runtimeWith(new Map(), ""), "--write", "cursor")).rejects.toThrow("the MCP listener isn't running");
    await expect(run(runtimeWith(new Map(), "tok"), "--write", "codex")).rejects.toThrow("codex reads ~/.codex/config.toml");
  });
});
