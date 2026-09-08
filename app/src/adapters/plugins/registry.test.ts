import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-plugins-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "good.ts"), "export const sdkVersion=1; export const environmentSources=[{name:'custom',load:()=>({OK:'yes'})}];");
  writeFileSync(join(dir, "old.ts"), "export const sdkVersion=0;");
  writeFileSync(join(dir, "throwing.ts"), "throw new Error('boom');");
  writeFileSync(join(dir, "malformed.ts"), "export const sdkVersion=1; export const healthChecks=[{name:'bad'}];");
  const registry = await loadPluginPaths(["good.ts", "old.ts", "throwing.ts", "malformed.ts"], dir);
  expect(registry.environmentSources.some((source) => source.name === "custom")).toBe(true);
  expect(registry.loadErrors).toHaveLength(3);
  expect(registry.loadErrors.map((error) => error.message).join(" ")).toMatch(/incompatible.*boom.*check must be a function/);
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
