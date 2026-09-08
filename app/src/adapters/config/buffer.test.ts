import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { validateConfigText } from "./load.ts";

function tmp(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-buffer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(join(dir, ".devctl"), { recursive: true });
  process.env.DEVCTL_HOME = join(dir, "home");
  return dir;
}

describe("config buffer", () => {
  test("rejects invalid YAML without treating it as a mapping", () => {
    const dir = tmp();
    const configPath = join(dir, ".devctl", "config.yaml");
    expect(validateConfigText(dir, configPath, "version: [")).toEqual([expect.stringMatching(/invalid YAML/)]);
  });

  test("rejects unknown fields", () => {
    const dir = tmp();
    const configPath = join(dir, ".devctl", "config.yaml");
    expect(validateConfigText(dir, configPath, "version: 1\nmystery: true\n")).toEqual([expect.stringMatching(/unknown fields/)]);
  });

  test("accepts a minimal valid file", () => {
    const dir = tmp();
    const configPath = join(dir, ".devctl", "config.yaml");
    expect(validateConfigText(dir, configPath, "version: 1\nservices:\n  api:\n    command: echo hi\n")).toEqual([]);
  });

  test("validates unsaved buffer text through the real modular pipeline, not a hand-rolled subset", () => {
    const dir = tmp();
    const configPath = join(dir, ".devctl", "config.yaml");
    // "extra" is defined only in the on-disk modular services/ directory —
    // never in the root file, saved or candidate. A profile in the candidate
    // buffer text can reference it only if buffer validation actually runs
    // loadModular() over the real .devctl directory, not a simplified
    // re-implementation that only looks at the root text.
    mkdirSync(join(dir, ".devctl", "services"), { recursive: true });
    writeFileSync(join(dir, ".devctl", "services", "extra.yaml"), "command: [echo, extra]\n");
    writeFileSync(configPath, "version: 1\n");
    const candidate = "version: 1\nprofiles:\n  backend:\n    services: [extra]\n";
    expect(validateConfigText(dir, configPath, candidate)).toEqual([]);
  });

  test("still catches a candidate buffer referencing a genuinely unknown service", () => {
    const dir = tmp();
    const configPath = join(dir, ".devctl", "config.yaml");
    writeFileSync(configPath, "version: 1\n");
    const candidate = "version: 1\nprofiles:\n  backend:\n    services: [ghost]\n";
    expect(validateConfigText(dir, configPath, candidate)).toEqual([expect.stringMatching(/unknown service "ghost"/)]);
  });

  test("resolves template inheritance through the real presence-aware merge, not a simplified one", () => {
    const dir = tmp();
    const configPath = join(dir, ".devctl", "config.yaml");
    // api only re-states health.type, not health.url. Nested sections merge
    // field by field through the template chain, so url should still come
    // from the template. A buffer path that fell back to whole-object
    // replacement would silently drop it and validate() would wrongly
    // report health.url missing.
    const candidate = `
version: 1
templates:
  base:
    health:
      type: http
      url: http://127.0.0.1:8000/health
services:
  api:
    extends: base
    command: echo hi
    health:
      type: http
`;
    expect(validateConfigText(dir, configPath, candidate)).toEqual([]);
  });
});
