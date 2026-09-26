import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_PORT_SLOTS } from "../../domain/net/port-slots.ts";
import { loadPath } from "../config/index.ts";
import { claimSlot, currentSlot, instancesPath, readInstances, recordInstancePorts, releaseSlot, startWithSlot } from "./instances.ts";

let previousHome: string | undefined;
let previousInstance: string | undefined;

beforeEach(() => {
  previousHome = process.env.DEVCTL_HOME;
  previousInstance = process.env.DEVCTL_INSTANCE;
  process.env.DEVCTL_HOME = mkdtempSync(join(tmpdir(), "devctl-instances-"));
  delete process.env.DEVCTL_INSTANCE;
});

afterEach(() => {
  for (const [key, value] of [["DEVCTL_HOME", previousHome], ["DEVCTL_INSTANCE", previousInstance]] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function asInstance<T>(name: string, fn: () => T): T {
  process.env.DEVCTL_INSTANCE = name;
  try {
    return fn();
  } finally {
    delete process.env.DEVCTL_INSTANCE;
  }
}

describe("instance slot registry", () => {
  test("the first checkout takes slot 0, the next slot 1, and each keeps its slot", () => {
    expect(claimSlot("/src/app").slot).toBe(0);
    expect(claimSlot("/src/app-review").slot).toBe(1);
    expect(claimSlot("/src/app").slot).toBe(0);
    // Same checkout, different spelling: still one entry.
    expect(claimSlot("/src/app-review/").slot).toBe(1);
    // Stored resolved (D:\src\app on Windows).
    expect(readInstances().map((entry) => [entry.slot, entry.repoRoot])).toEqual([
      [0, resolve("/src/app")],
      [1, resolve("/src/app-review")],
    ]);
    expect(currentSlot("/src/app-review")).toBe(1);
    expect(currentSlot("/src/unknown")).toBe(0);
  });

  test("a named instance of a checkout holds a slot of its own", () => {
    expect(claimSlot("/src/app").slot).toBe(0);
    expect(asInstance("ci-7", () => claimSlot("/src/app"))).toEqual({ slot: 1, claimed: true });
    expect(asInstance("ci-7", () => currentSlot("/src/app"))).toBe(1);
    expect(currentSlot("/src/app")).toBe(0);
    expect(readInstances().map((entry) => [entry.slot, entry.instance])).toEqual([
      [0, undefined],
      [1, "ci-7"],
    ]);
    asInstance("ci-7", () => releaseSlot("/src/app"));
    expect(readInstances().map((entry) => entry.slot)).toEqual([0]);
  });

  test("an invalid instance name is rejected before anything is written", () => {
    expect(() => asInstance("Bad Name", () => claimSlot("/src/app"))).toThrow('invalid instance name "Bad Name"');
    expect(readInstances()).toEqual([]);
  });

  test("claimed is true only for the call that created the claim", () => {
    expect(claimSlot("/a")).toEqual({ slot: 0, claimed: true });
    expect(claimSlot("/a")).toEqual({ slot: 0, claimed: false });
  });

  test("a failed start gives back the slot it claimed", async () => {
    await expect(startWithSlot("/a", () => Promise.reject(new Error("invalid config")))).rejects.toThrow("invalid config");
    expect(readInstances()).toEqual([]);
    expect(await startWithSlot("/b", (slot) => Promise.resolve(slot))).toBe(0);
    expect(readInstances().map((entry) => entry.slot)).toEqual([0]);
  });

  test("a failed start keeps a slot the checkout already held", async () => {
    claimSlot("/a");
    claimSlot("/b");
    await expect(startWithSlot("/b", () => Promise.reject(new Error("invalid config")))).rejects.toThrow("invalid config");
    expect(currentSlot("/b")).toBe(1);
  });

  test("a freed slot is reused by the next checkout", () => {
    claimSlot("/a");
    claimSlot("/b");
    releaseSlot("/a");
    expect(claimSlot("/c").slot).toBe(0);
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
    expect(claimSlot("/a").slot).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  test("a corrupt registry reads as empty", () => {
    mkdirSync(process.env.DEVCTL_HOME ?? "", { recursive: true });
    writeFileSync(instancesPath(), "{not json");
    expect(readInstances()).toEqual([]);
    expect(claimSlot("/a").slot).toBe(0);
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
    expect(cfg.instance).toEqual({ name: "", slot: 1, portOffset: 100 });
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
