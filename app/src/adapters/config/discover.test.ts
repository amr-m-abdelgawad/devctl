import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { discover } from "./discover.ts";

// Pre-resolved (drive-qualified on win32) so every join()'d path built from
// it already matches what discoverExplicit()'s own resolve(explicit) call
// returns — resolve() on an already-resolved path is a no-op, so the test
// bodies below can compare directly against these fixtures.
function tmp(): string {
  return resolve(join(process.env.TMPDIR ?? "/tmp", `devctl-discover-${Date.now()}-${Math.random().toString(16).slice(2)}`));
}

describe("discover", () => {
  test("explicit path to a config file directly under a .devctl directory resolves repoRoot to its parent", () => {
    const dir = tmp();
    const configPath = join(dir, ".devctl", "config.yaml");
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(configPath, "version: 1\n");
    const result = discover("", configPath);
    expect(result.repoRoot).toBe(dir);
    expect(result.configPath).toBe(configPath);
  });

  test("explicit path to the .devctl directory itself resolves repoRoot to its parent, not the .devctl dir", () => {
    const dir = tmp();
    const devctlDir = join(dir, ".devctl");
    mkdirSync(devctlDir, { recursive: true });
    writeFileSync(join(devctlDir, "config.yaml"), "version: 1\n");
    const result = discover("", devctlDir);
    expect(result.repoRoot).toBe(dir);
    expect(result.configPath).toBe(join(devctlDir, "config.yaml"));
  });

  test("explicit path to a repo root containing a bare config.yaml resolves repoRoot to that directory", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "version: 1\n");
    const result = discover("", dir);
    expect(result.repoRoot).toBe(dir);
    expect(result.configPath).toBe(join(dir, "config.yaml"));
  });

  test("explicit path to a single-file config (no .devctl directory) resolves repoRoot to its parent", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "devctl.yaml");
    writeFileSync(configPath, "version: 1\n");
    const result = discover("", configPath);
    expect(result.repoRoot).toBe(dir);
    expect(result.configPath).toBe(configPath);
  });

  test("explicit path that does not exist throws", () => {
    const dir = tmp();
    expect(() => discover("", join(dir, "missing.yaml"))).toThrow();
  });
});
