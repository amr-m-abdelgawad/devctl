import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadOrEmpty, type DevctlConfig } from "../config/index.ts";
import { callMcpTool, MCP_TOOLS, type McpHost } from "./tools.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "devctl-setup-"));
}

// Only config() is exercised by the setup tools; the rest of McpHost exists to
// satisfy the type and throws if anything unexpectedly reaches for it.
function hostFor(cfg: DevctlConfig): McpHost {
  const unused = (): never => {
    throw new Error("setup tools must not touch the running supervisor");
  };
  return {
    config: () => cfg,
    status: unused,
    logsPage: unused,
    start: unused,
    stop: unused,
    restart: unused,
    reload: unused,
    doctor: unused,
  };
}

const VALID = `version: 1
services:
  api:
    command: [echo, hi]
`;

describe("loadOrEmpty", () => {
  test("returns an empty config rooted where one would go when none exists", () => {
    const dir = tmp();
    const cfg = loadOrEmpty(dir, "");
    expect(cfg.repoRoot).toBe(dir);
    expect(cfg.configPath).toBe(join(dir, ".devctl", "config.yaml"));
    expect(Object.keys(cfg.services)).toEqual([]);
  });

  test("still loads a real configuration when one exists", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"));
    writeFileSync(join(dir, ".devctl", "config.yaml"), VALID);
    expect(Object.keys(loadOrEmpty(dir, "").services)).toEqual(["api"]);
  });

  // The distinction that keeps setup mode from being destructive: a config
  // that is present but broken must not be silently replaced with an empty
  // one, or an agent would be invited to overwrite the user's real file.
  test("an invalid configuration still throws rather than becoming an empty one", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"));
    writeFileSync(join(dir, ".devctl", "config.yaml"), "version: 1\nservices: {}\n");
    expect(() => loadOrEmpty(dir, "")).toThrow(/at least one service must be defined/);
  });
});

describe("validate_config", () => {
  test("validates candidate text before anything is on disk", async () => {
    const dir = tmp();
    const host = hostFor(loadOrEmpty(dir, ""));
    const ok = (await callMcpTool(host, "validate_config", { text: VALID })) as { valid: boolean; source: string };
    expect(ok).toMatchObject({ valid: true, source: "candidate" });
    expect((ok as unknown as { issues: string[] }).issues).toEqual([]);
  });

  test("returns the loader's own issues for a bad candidate", async () => {
    const dir = tmp();
    const host = hostFor(loadOrEmpty(dir, ""));
    const bad = (await callMcpTool(host, "validate_config", {
      text: "version: 1\nservices:\n  a: { command: [echo, a], ports: { http: 80 } }\n  b: { command: [echo, b], ports: { http: 80 } }\n",
    })) as { valid: boolean; issues: string[] };
    expect(bad.valid).toBe(false);
    expect(bad.issues).toEqual(["duplicate port 80 used by a and b"]);
  });

  test("reports setup mode rather than a parse error when nothing is written yet", async () => {
    const dir = tmp();
    const host = hostFor(loadOrEmpty(dir, ""));
    const res = (await callMcpTool(host, "validate_config", {})) as { valid: boolean; setup_mode: boolean; issues: string[] };
    expect(res.valid).toBe(false);
    expect(res.setup_mode).toBe(true);
    expect(res.issues[0]).toContain("no configuration at");
  });

  test("validates what is actually on disk once it exists", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"));
    writeFileSync(join(dir, ".devctl", "config.yaml"), VALID);
    const host = hostFor(loadOrEmpty(dir, ""));
    const res = (await callMcpTool(host, "validate_config", {})) as { valid: boolean; source: string };
    expect(res).toMatchObject({ valid: true, source: "disk" });
  });

  // Modular layouts are the shape the guide tells an agent to write, so
  // candidate validation has to see the sibling files, not just the text.
  test("candidate text is merged with modular files already on disk", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl", "services"), { recursive: true });
    writeFileSync(join(dir, ".devctl", "services", "api.yaml"), "command: [echo, hi]\nports:\n  http: 8000\n");
    const cfg = defaultConfig();
    cfg.repoRoot = dir;
    cfg.configPath = join(dir, ".devctl", "config.yaml");
    const host = hostFor(cfg);
    // The candidate declares no services at all; it only validates because
    // services/api.yaml is picked up by the same pipeline a real load uses.
    const res = (await callMcpTool(host, "validate_config", { text: "version: 1\n" })) as { valid: boolean; issues: string[] };
    expect(res).toMatchObject({ valid: true });
    // A profile in the candidate can therefore reference that modular service.
    const withProfile = (await callMcpTool(host, "validate_config", {
      text: "version: 1\nprofiles:\n  dev:\n    services: [api]\n",
    })) as { valid: boolean };
    expect(withProfile.valid).toBe(true);
  });
});

describe("setup tool surface", () => {
  test("both tools are advertised", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toContain("get_setup_guide");
    expect(names).toContain("validate_config");
  });

  // Shape A: the server hands over knowledge and verification, never writes.
  // If a write tool is ever added this test should be updated deliberately,
  // not tripped over.
  test("no tool claims to write files", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.name).not.toMatch(/^(write|apply|create|delete)_/);
    }
  });
});

describe("supervisor setup mode", () => {
  test("starts in setup mode, clears it on the reload that finds a configuration", async () => {
    const dir = tmp();
    const { Supervisor } = await import("../supervisor.ts");
    const cfg = loadOrEmpty(dir, "");
    cfg.logs.persistence.enabled = false;
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    expect(sup.snapshot().setup_mode).toBe(true);

    // Reloading before anything is written must surface the failure and leave
    // the daemon standing — this is the state an agent sits in while drafting.
    await expect(sup.reload()).rejects.toThrow();
    expect(sup.snapshot().setup_mode).toBe(true);

    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(join(dir, ".devctl", "config.yaml"), VALID);
    await sup.reload();
    expect(sup.snapshot().setup_mode).toBeUndefined();
    expect(Object.keys(sup.snapshot().services)).toEqual(["api"]);
  });
});
