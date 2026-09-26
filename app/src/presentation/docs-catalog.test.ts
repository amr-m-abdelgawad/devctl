import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newRoot } from "../bootstrap/test-client.ts";
import { defaultConfig } from "../domain/config/types.ts";
import { MCP_TOOLS } from "./mcp/tools.ts";

const repoRoot = dirname(dirname(dirname(import.meta.dir)));

function readDoc(name: string): string {
  return readFileSync(join(repoRoot, "docs", name), "utf8");
}

const INTERNAL_CLI = new Set(["_supervisor", "__complete", "help"]);
const SYNTHESIZED_CONFIG = new Set(["provenance", "repoRoot", "configPath", "instance"]);

describe("operator docs catalogs", () => {
  test("docs/cli.md lists every user-facing CLI command", () => {
    const docs = readDoc("cli.md");
    const names = newRoot()
      .commands.map((cmd) => cmd.name())
      .filter((name) => !INTERNAL_CLI.has(name));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(docs).toContain(`devctl ${name}`);
    }
  });

  test("docs/mcp.md lists every MCP tool", () => {
    const table = readDoc("mcp.md").split("## Tools and resources")[1]?.split("## Enabling")[0] ?? "";
    expect(table.length).toBeGreaterThan(0);
    for (const tool of MCP_TOOLS) {
      expect(table).toContain(`\`${tool.name}\``);
    }
  });

  test("docs/configuration.md names every user-facing top-level config key", () => {
    const docs = readDoc("configuration.md");
    for (const key of Object.keys(defaultConfig())) {
      if (SYNTHESIZED_CONFIG.has(key)) {
        continue;
      }
      expect(docs).toContain(key);
    }
  });

  test("wiki home lists telemetry next to the other operator surfaces", () => {
    const home = readDoc("README.md");
    expect(home).toContain("[Telemetry](telemetry.md)");
    expect(home).toContain("web console");
  });
});
