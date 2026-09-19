import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, emptyRouteAuth } from "../../domain/config/types.ts";
import { checkPluginInspectDecoders, pluginMtimes, reapplyPlugins, registryForNextPlugins, type ReloadHost } from "./reload.ts";

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
    logs: { setParsers() {}, setServiceLogs() {}, setSecrets() {} } as unknown as ReloadHost["logs"],
    persistState() {},
    log() {},
    refreshIdentity: async () => undefined,
    startProxy: async () => undefined,
    stopProxy: async () => undefined,
    reload: async () => ({ restart_required: [], changes: {} }),
    forgetService() {},
    syncServiceWatchers() {},
    syncWebListener: async () => undefined,
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

  test("candidate registry includes newly listed inspect decoders", async () => {
    const dir = tempDir();
    const path = join(dir, "decoder.ts");
    writeFileSync(path, "export const sdkVersion=1; export const trafficDecoders=[{name:'temporal',decode:()=>({ok:true})}];");
    const host = stubHost(dir, []);
    host.cfg.repoRoot = dir;
    const next = defaultConfig();
    next.repoRoot = dir;
    next.plugins = [{ path }];
    next.proxy.routes.push({
      name: "temporal",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      inspect: { enabled: true, max_bytes: 0, grpc: { decoder: "temporal" } },
    });
    const registry = await registryForNextPlugins(host, next);
    expect(registry?.trafficDecoders.some((decoder) => decoder.name === "temporal")).toBe(true);
    expect(() => checkPluginInspectDecoders(host.registry, next)).toThrow(/unknown inspect decoder/);
    expect(() => checkPluginInspectDecoders(registry, next)).not.toThrow();
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
