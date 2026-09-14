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
          cfg: { repoRoot: "/repo", ui: { keymap: {} } },
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
