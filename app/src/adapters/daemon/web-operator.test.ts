import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../config/index.ts";
import { webConfigFiles } from "../config/web-config-files.ts";
import { Supervisor } from "../../bootstrap/test-supervisor.ts";
import type { WebHost } from "../../ports/web-host.ts";
import { defaultConfig } from "../../domain/config/types.ts";
import { loadTuiConfig } from "../config/tui-preferences.ts";

test("web config edits validate before writing, detect external changes, and reload through the supervisor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "devctl-web-operator-"));
  const previousHome = process.env.DEVCTL_HOME;
  process.env.DEVCTL_HOME = join(directory, "state");
  const configPath = join(directory, ".devctl", "config.yaml");
  mkdirSync(join(directory, ".devctl"));
  const original =
    "version: 1\nproject:\n  name: editor-test\nservices:\n  api:\n    command: [echo, hello]\nprofiles:\n  local:\n    services: [api]\n";
  writeFileSync(configPath, original);
  const supervisor = new Supervisor(load(directory, configPath), { webConfigFiles });
  const host = (supervisor as unknown as { asWebHost(): WebHost }).asWebHost();
  try {
    const document = host.operator!.readConfig();
    const invalid = await host.operator!.saveConfig("services: [not-a-mapping]", document.revision);
    expect(invalid.saved).toBe(false);
    expect(invalid.issues.length).toBeGreaterThan(0);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    writeFileSync(configPath, `${original}# changed elsewhere\n`);
    const conflict = await host.operator!.saveConfig(original, document.revision);
    expect(conflict.conflict).toBe(true);
    const current = host.operator!.readConfig();
    const result = await host.operator!.saveConfig(current.text.replace("editor-test", "edited-project"), current.revision);
    expect(result.saved).toBe(true);
    expect(result.reload_error).toBeUndefined();
    expect(host.config().project.name).toBe("edited-project");
    expect(host.operator!.planStart({ profile: "local" }).waves).toEqual([["api"]]);
  } finally {
    await supervisor.shutdown(false);
    if (previousHome === undefined) delete process.env.DEVCTL_HOME;
    else process.env.DEVCTL_HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("web exec returns captured failure output while CLI exec preserves its failure behavior", async () => {
  const directory = mkdtempSync(join(tmpdir(), "devctl-web-exec-"));
  const previousHome = process.env.DEVCTL_HOME;
  process.env.DEVCTL_HOME = join(directory, "state");
  const configPath = join(directory, ".devctl", "config.yaml");
  mkdirSync(join(directory, ".devctl"));
  writeFileSync(configPath, "version: 1\nproject:\n  name: exec-test\nservices:\n  api:\n    command: [echo, hello]\n");
  const supervisor = new Supervisor(load(directory, configPath));
  const command = [process.execPath, "-e", "console.log('captured output'); process.exit(7)"];
  try {
    const host = (supervisor as unknown as { asWebHost(): WebHost }).asWebHost();
    const result = await host.exec!("api", command);
    expect(result.code).toBe(7);
    expect(result.stdout).toBe("captured output\n");
    await expect(supervisor.execService("api", command)).rejects.toThrow("exited with code 7");
  } finally {
    await supervisor.shutdown(false);
    if (previousHome === undefined) delete process.env.DEVCTL_HOME;
    else process.env.DEVCTL_HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("web MCP preferences apply to the live listener and persist explicit tool permissions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "devctl-web-mcp-"));
  const previousHome = process.env.DEVCTL_HOME;
  process.env.DEVCTL_HOME = join(directory, "state");
  const cfg = defaultConfig();
  cfg.repoRoot = directory;
  const opened: number[] = [];
  let stopped = 0;
  const supervisor = new Supervisor(cfg, {
    createMcpListener: ({ port }) => {
      let running = false;
      return {
        start: async () => {
          running = true;
          opened.push(port);
        },
        stop: async () => {
          running = false;
          stopped++;
        },
        isRunning: () => running,
        listenPort: () => port,
        address: () => `127.0.0.1:${port}`,
      };
    },
  });
  const host = (supervisor as unknown as { asWebHost(): WebHost }).asWebHost();
  try {
    await host.setPreferences!({ scope: "repo", mcp_enabled: true, mcp_port: 18712 });
    expect(host.status().mcp).toMatchObject({ running: true, port: 18712 });
    await host.operator!.setMcpTools(["stop_services"]);
    expect(host.status().mcp?.disabled_tools).toEqual(["stop_services"]);
    expect(loadTuiConfig(directory).mcp_enabled_tools).toContain("exec_service");
    await host.setPreferences!({ scope: "repo", mcp_port: 18713 });
    expect(opened).toEqual([18712, 18713]);
    await host.setPreferences!({ scope: "repo", mcp_enabled: false });
    expect(host.status().mcp?.running).toBe(false);
    expect(stopped).toBe(2);
  } finally {
    await supervisor.shutdown(false);
    if (previousHome === undefined) delete process.env.DEVCTL_HOME;
    else process.env.DEVCTL_HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  }
});
