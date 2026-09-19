import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { patchRepoLocalConfig, repoLocalConfigPath } from "./local-overlay.ts";

describe("local overlay patch", () => {
  test("creates .devctl/config.local.yaml with only the allowed web keys", () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-local-overlay-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = patchRepoLocalConfig(dir, { web_enabled: true, web_port: 18911 });
    expect(path).toBe(repoLocalConfigPath(dir));
    const text = readFileSync(path, "utf8");
    expect(text).toContain("enabled: true");
    expect(text).toContain("port: 18911");
    expect(text).not.toContain("host:");
    expect(text).not.toContain("inspect_max_bytes");
  });

  test("keeps hand-edited sibling keys when patching web.listen.port", () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-local-overlay-keep-${Date.now()}`);
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(
      join(dir, ".devctl", "config.local.yaml"),
      "proxy:\n  enabled: true\nweb:\n  enabled: false\n  listen:\n    host: 127.0.0.1\n    port: 18900\n",
    );
    patchRepoLocalConfig(dir, { web_enabled: true, web_port: 18912 });
    const text = readFileSync(join(dir, ".devctl", "config.local.yaml"), "utf8");
    expect(text).toContain("proxy:");
    expect(text).toContain("enabled: true");
    expect(text).toContain("host: 127.0.0.1");
    expect(text).toContain("port: 18912");
  });

  test("writes inspect caps without dropping sibling keys", () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-local-overlay-cap-${Date.now()}`);
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(
      join(dir, ".devctl", "config.local.yaml"),
      "proxy:\n  enabled: true\nweb:\n  enabled: true\n",
    );
    patchRepoLocalConfig(dir, { inspect_max_bytes: 8_388_608 });
    const text = readFileSync(join(dir, ".devctl", "config.local.yaml"), "utf8");
    expect(text).toContain("inspect_max_bytes: 8388608");
    expect(text).toContain("capture_max_bytes: 8388608");
    expect(text).toContain("proxy:");
    expect(text).toContain("enabled: true");
  });

  test("rejects a port outside the user range", () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-local-overlay-port-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    expect(() => patchRepoLocalConfig(dir, { web_port: 80 })).toThrow("web.listen.port");
  });
});
