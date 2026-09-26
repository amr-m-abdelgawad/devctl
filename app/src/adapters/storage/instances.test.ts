import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_PORT_SLOTS } from "../../domain/net/port-slots.ts";
import { loadPath } from "../config/index.ts";
import { claimSlot, currentSlot, instancesPath, readInstances, recordInstancePorts, releaseSlot } from "./instances.ts";

let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.DEVCTL_HOME;
  process.env.DEVCTL_HOME = mkdtempSync(join(tmpdir(), "devctl-instances-"));
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.DEVCTL_HOME;
  } else {
    process.env.DEVCTL_HOME = previousHome;
  }
});

describe("instance slot registry", () => {
  test("the first checkout takes slot 0, the next slot 1, and each keeps its slot", () => {
    expect(claimSlot("/src/app")).toBe(0);
    expect(claimSlot("/src/app-review")).toBe(1);
    expect(claimSlot("/src/app")).toBe(0);
    // Same checkout, different spelling: still one entry.
    expect(claimSlot("/src/app-review/")).toBe(1);
    expect(readInstances().map((entry) => [entry.slot, entry.repoRoot])).toEqual([
      [0, "/src/app"],
      [1, "/src/app-review"],
    ]);
    expect(currentSlot("/src/app-review")).toBe(1);
    expect(currentSlot("/src/unknown")).toBe(0);
  });

  test("a freed slot is reused by the next checkout", () => {
    claimSlot("/a");
    claimSlot("/b");
    releaseSlot("/a");
    expect(claimSlot("/c")).toBe(0);
    expect(currentSlot("/b")).toBe(1);
  });

  test("claiming fails with a hint once every slot is taken", () => {
    for (let i = 0; i < MAX_PORT_SLOTS; i += 1) {
      claimSlot(`/repo-${i}`);
    }
    expect(() => claimSlot("/one-more")).toThrow(`all ${MAX_PORT_SLOTS} port slots are taken`);
  });

  test("recorded listener ports are kept on the entry", () => {
    claimSlot("/a");
    recordInstancePorts("/a", { proxy: 18080, web: 18900 });
    expect(readInstances()[0]?.ports).toEqual({ proxy: 18080, web: 18900 });
  });

  test("a stale lock left by a crashed writer is taken over", () => {
    mkdirSync(process.env.DEVCTL_HOME ?? "", { recursive: true });
    const lock = `${instancesPath()}.lock`;
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(claimSlot("/a")).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  test("a corrupt registry reads as empty", () => {
    mkdirSync(process.env.DEVCTL_HOME ?? "", { recursive: true });
    writeFileSync(instancesPath(), "{not json");
    expect(readInstances()).toEqual([]);
    expect(claimSlot("/a")).toBe(0);
  });

  test("loading a checkout's config applies its slot", () => {
    const repo = mkdtempSync(join(tmpdir(), "devctl-slot-repo-"));
    mkdirSync(join(repo, ".devctl"), { recursive: true });
    const configPath = join(repo, ".devctl", "config.yaml");
    writeFileSync(
      configPath,
      `version: 1
services:
  api:
    command: [echo, ok]
    ports:
      http: 18000
web:
  enabled: true
  listen:
    port: 18900
`,
    );
    claimSlot("/someone-else");
    claimSlot(repo);
    const cfg = loadPath(repo, configPath);
    expect(cfg.instance).toEqual({ slot: 1, portOffset: 100 });
    expect(cfg.services.api?.ports[0]?.value).toBe(18100);
    expect(cfg.web.listen.port).toBe(19000);
    // An explicit slot overrides the registry.
    expect(loadPath(repo, configPath, { slot: 0 }).services.api?.ports[0]?.value).toBe(18000);
  });

  test("a port pushed past 65535 by the offset fails validation", () => {
    const repo = mkdtempSync(join(tmpdir(), "devctl-slot-overflow-"));
    mkdirSync(join(repo, ".devctl"), { recursive: true });
    const configPath = join(repo, ".devctl", "config.yaml");
    writeFileSync(configPath, "version: 1\nservices:\n  api:\n    command: [echo, ok]\n    ports:\n      http: 65500\n");
    expect(() => loadPath(repo, configPath, { slot: 1 })).toThrow("invalid port 65600");
  });
});
