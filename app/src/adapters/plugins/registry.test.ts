import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPluginPaths, Registry } from "./registry.ts";

describe("plugin registry", () => {
  test("registers built-in token identity log and proxy hooks", () => {
    const registry = new Registry();
    registry.registerBuiltins();
    expect(registry.tokenProviders.some((p) => p.name === "iap")).toBe(true);
    expect(registry.identityProviders.some((p) => p.name === "service_account")).toBe(true);
    expect(registry.logParsers.some((p) => p.name === "default")).toBe(true);
    expect(registry.proxyMiddleware.some((p) => p.name === "identity_inject")).toBe(true);
  });
});

test("plugin loading negotiates SDK versions and isolates bad modules", async () => {
  const dir = join(tmpdir(), `devctl-plugins-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "good.ts"), "export const sdkVersion=1; export const environmentSources=[{name:'custom',load:()=>({OK:'yes'})}];");
  writeFileSync(join(dir, "old.ts"), "export const sdkVersion=0;");
  writeFileSync(join(dir, "throwing.ts"), "throw new Error('boom');");
  writeFileSync(join(dir, "malformed.ts"), "export const sdkVersion=1; export const healthChecks=[{name:'bad'}];");
  const registry = await loadPluginPaths(["good.ts", "old.ts", "throwing.ts", "malformed.ts"], dir);
  expect(registry.environmentSources.some((source) => source.name === "custom")).toBe(true);
  expect(registry.pluginPaths).toEqual([resolve(dir, "good.ts")]);
  expect(registry.loadErrors).toHaveLength(3);
  expect(registry.loadErrors.map((error) => error.message).join(" ")).toMatch(/incompatible.*boom.*check must be a function/);
});

test("refuses plugin paths outside the repository root", async () => {
  const root = join(tmpdir(), `devctl-plugins-root-${Date.now()}-${Math.random()}`);
  const outside = join(tmpdir(), `devctl-plugins-out-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "inside.ts"), "export const sdkVersion=1; export const environmentSources=[{name:'ok',load:()=>({})}];");
  writeFileSync(join(outside, "evil.ts"), "export const sdkVersion=1; export const environmentSources=[{name:'evil',load:()=>({})}];");
  const registry = await loadPluginPaths(["inside.ts", join(outside, "evil.ts"), `file://${join(outside, "evil.ts")}`], root);
  expect(registry.pluginPaths).toEqual([resolve(root, "inside.ts")]);
  expect(registry.environmentSources.some((source) => source.name === "evil")).toBe(false);
  expect(registry.loadErrors).toHaveLength(2);
  expect(registry.loadErrors.every((error) => /inside the repository root/.test(error.message))).toBe(true);
});

test("refuses an in-root symlink that resolves outside the repository", async () => {
  if (process.platform === "win32") {
    return; // symlink creation needs elevation on Windows CI
  }
  const root = join(tmpdir(), `devctl-plugins-symroot-${Date.now()}-${Math.random()}`);
  const outside = join(tmpdir(), `devctl-plugins-symout-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "evil.ts"), "export const sdkVersion=1; export const environmentSources=[{name:'evil',load:()=>({})}];");
  symlinkSync(join(outside, "evil.ts"), join(root, "link.ts"));
  const registry = await loadPluginPaths(["link.ts"], root);
  expect(registry.environmentSources.some((source) => source.name === "evil")).toBe(false);
  expect(registry.pluginPaths).toEqual([]);
  expect(registry.loadErrors).toHaveLength(1);
  expect(registry.loadErrors[0]?.message).toMatch(/symlink.*outside the repository/);
});

test("tracks plugin identity providers by origin rather than reserved names", () => {
  const registry = new Registry();
  registry.registerBuiltins();
  registry.register({
    sdkVersion: 1,
    identityProviders: [{ name: "user", accepts: (cfg) => cfg.type === "custom", resolve: async () => { throw new Error("unused"); } }],
  });
  expect(registry.pluginIdentityProviders).toHaveLength(1);
  expect(registry.pluginIdentityProviders[0]?.name).toBe("user");
});
