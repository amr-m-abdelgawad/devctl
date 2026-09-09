import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../domain/config/types.ts";
import { pluginMtimes, reapplyPlugins, type ReloadHost } from "./reload.ts";

const PLUGIN = `export const sdkVersion = 1;
export const tokenProviders = [];
`;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devctl-plugin-"));
  temps.push(dir);
  return dir;
}

function writePlugin(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, PLUGIN);
  return path;
}

function stubHost(repoRoot: string, prevPaths: string[]): ReloadHost {
  return {
    cfg: defaultConfig(),
    setupMode: false,
    restartRequired: [],
    fs: { exists: () => true, readText: () => "", writeText: () => undefined },
    registry: undefined,
    pluginMtimes: pluginMtimes(prevPaths, repoRoot),
    detector: { update() {}, extraMarkers: [], extraPatterns: [] } as unknown as ReloadHost["detector"],
    bus: { publish() {}, subscribe() { return () => undefined; } } as unknown as ReloadHost["bus"],
    orchestrator: { serviceIsActive: () => false } as unknown as ReloadHost["orchestrator"],
    runtimes: new Map(),
    tokens: { replaceProviders() {} } as unknown as ReloadHost["tokens"],
    logs: { setParsers() {}, setSecrets() {} } as unknown as ReloadHost["logs"],
    persistState() {},
    log() {},
    refreshIdentity: async () => undefined,
    startProxy: async () => undefined,
    stopProxy: async () => undefined,
    reload: async () => ({ restart_required: [], changes: {} }),
    forgetService() {},
    syncServiceWatchers() {},
  };
}

describe("plugin reload", () => {
  test("a new path list hot-applies without supervisor restart", async () => {
    const dir = tempDir();
    const first = writePlugin(dir, "one.ts");
    const second = writePlugin(dir, "two.ts");
    const host = stubHost(dir, [first]);
    const next = defaultConfig();
    next.repoRoot = dir;
    next.plugins = [{ path: first }, { path: second }];
    const restart = await reapplyPlugins(host, next, [first]);
    expect(restart).toEqual([]);
    expect(host.registry?.pluginPaths.length).toBeGreaterThan(0);
  });

  test("same path with a newer mtime advises supervisor restart", async () => {
    const dir = tempDir();
    const path = writePlugin(dir, "plug.ts");
    const host = stubHost(dir, [path]);
    const stored = host.pluginMtimes.get(path);
    expect(stored).toBeDefined();
    host.pluginMtimes.set(path, (stored ?? 0) - 1);
    const next = defaultConfig();
    next.repoRoot = dir;
    next.plugins = [{ path }];
    const restart = await reapplyPlugins(host, next, [path]);
    expect(restart).toContain("plugins");
  });
});
