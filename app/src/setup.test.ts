import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { createStarterConfig, resolveSetupTarget, runSetup } from "./setup.ts";

// join() (not string interpolation) for correct separators, and
// pre-resolved (drive-qualified on win32) so it already matches what
// resolveSetupTarget's own resolve(explicitConfig) call returns for the
// explicit-config tests below.
function tmp(): string {
  const dir = resolve(join(process.env.TMPDIR ?? "/tmp", `devctl-setup-${Date.now()}-${Math.random().toString(16).slice(2)}`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

describe("setup", () => {
  test("createStarterConfig refuses to overwrite an existing config without force", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(join(dir, ".devctl", "config.yaml"), "version: 1\n# hand-written, do not clobber\n");
    expect(() => createStarterConfig(dir)).toThrow(/already exists/);
    expect(readFileSync(join(dir, ".devctl", "config.yaml"), "utf8")).toContain("hand-written");
  });

  test("createStarterConfig overwrites when force is set", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(join(dir, ".devctl", "config.yaml"), "version: 1\n# stale\n");
    const path = createStarterConfig(dir, "demo", "", "", true);
    expect(path).toBe(join(dir, ".devctl", "config.yaml"));
    const written = readFileSync(path, "utf8");
    expect(written).toContain("project:");
    expect(written).not.toContain("stale");
  });

  test("createStarterConfig writes fresh when nothing exists yet", () => {
    const dir = tmp();
    const path = createStarterConfig(dir, "demo");
    expect(existsSync(path)).toBe(true);
  });

  test("resolveSetupTarget honors an explicit --config directory that does not exist yet", () => {
    const dir = tmp();
    const target = join(dir, "custom", ".devctl");
    expect(resolveSetupTarget("", target)).toEqual({ repo: join(dir, "custom"), cfgPath: join(target, "config.yaml") });
  });

  test("resolveSetupTarget honors an explicit --config file path", () => {
    const dir = tmp();
    const target = join(dir, "custom", ".devctl", "config.yaml");
    expect(resolveSetupTarget("", target)).toEqual({ repo: join(dir, "custom"), cfgPath: target });
  });

  test("resolveSetupTarget falls back to cwd-derived .devctl/config.yaml when --config is not given", () => {
    // No --config means resolveSetupTarget never calls resolve() — repo
    // comes back exactly as passed in, and cfgPath is a plain join() of it
    // (separator-normalized, not drive-qualified), so the expected cfgPath
    // must be built with join() too rather than a hardcoded POSIX literal.
    expect(resolveSetupTarget("/some/repo", "")).toEqual({ repo: "/some/repo", cfgPath: join("/some/repo", ".devctl", "config.yaml") });
  });

  test("runSetup does not prompt or write when a config already exists and --force is not set", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    const original = "version: 1\n# hand-written, do not clobber\n";
    writeFileSync(join(dir, ".devctl", "config.yaml"), original);
    const cap = captureStdout();
    try {
      // If this reached the interactive prompts it would hang waiting on
      // stdin (no TTY in the test runner) until the test times out — so a
      // fast, clean return here is itself proof the early-exit guard fired.
      await runSetup(dir);
    } finally {
      cap.restore();
    }
    expect(cap.output()).toContain(join(dir, ".devctl", "config.yaml"));
    expect(cap.output()).toContain("nothing written");
    expect(readFileSync(join(dir, ".devctl", "config.yaml"), "utf8")).toBe(original);
  });
});
