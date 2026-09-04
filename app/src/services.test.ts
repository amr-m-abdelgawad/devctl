import { describe, expect, test } from "bun:test";
import { defaultConfig, type DevctlConfig } from "./config/types.ts";
import { emptyRuntime, firstProfileName, resolveProfile, resolveStartRequest, shutdownPlan, shutdownPlanExact, startupPlan, supervisorRestartAdvice } from "./services.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function cfg(deps: Record<string, string[]>): DevctlConfig {
  const c = defaultConfig();
  c.version = 1;
  for (const [name, dependencies] of Object.entries(deps)) {
    c.services[name] = {
      ...c.services[name],
      extends: "",
      description: "",
      command: { args: ["true"], shell: false },
      shell: false,
      working_dir: "",
      dependencies,
      ports: [],
      environment: { vars: {}, required: [], defaults: {} },
      health: { type: "", url: "", address: "", command: { args: [], shell: false }, interval_seconds: 0, timeout_seconds: 0 },
      identity: { type: "", mode: "", service_account: "" },
      logs: { stdout: false, stderr: false },
      restart: { policy: "", max_retries: 0, backoff_seconds: 0 },
      startup: { wait_for_healthy: false, timeout_seconds: 0 },
      hooks: { pre_start: { args: [], shell: false }, post_start: { args: [], shell: false } },
      capabilities: [],
      proxy: [],
    };
  }
  return c;
}

describe("startup plan", () => {
  test("orders dependencies first", () => {
    const plan = startupPlan(cfg({ auth: [], api: ["auth"], worker: ["api"] }), ["worker"], "backend");
    expect(plan.waves).toEqual([["auth"], ["api"], ["worker"]]);
    expect(plan.profile).toBe("backend");
  });

  test("shutdown cascades to dependents, never to dependencies", () => {
    const c = cfg({ auth: [], api: ["auth"], worker: ["api"] });
    // Stopping a leaf dependency must cascade forward to everything that
    // (transitively) depends on it — api and worker both need auth.
    expect(shutdownPlan(c, ["auth"]).waves).toEqual([["worker"], ["api"], ["auth"]]);
    // Stopping something in the middle of the chain must not also stop its
    // own dependency (auth may still be needed by other services).
    expect(shutdownPlan(c, ["api"]).waves).toEqual([["worker"], ["api"]]);
    // Stopping a leaf dependent touches only itself.
    expect(shutdownPlan(c, ["worker"]).waves).toEqual([["worker"]]);
  });

  test("shutdownPlanExact stops only the named services, in dependency order", () => {
    const c = cfg({ auth: [], api: ["auth"], worker: ["api"] });
    expect(shutdownPlanExact(c, ["auth", "api"]).waves).toEqual([["api"], ["auth"]]);
    expect(shutdownPlanExact(c, ["api"]).waves).toEqual([["api"]]);
  });
});

describe("resolveProfile", () => {
  test("named services do not pull in the rest of the profile", () => {
    const c = cfg({ auth: [], api: ["auth"], worker: ["api"] });
    c.profiles = { backend: { services: ["auth", "api", "worker"], environment: { REGION: "eu" } } };
    const named = resolveProfile(c, "backend", ["api"]);
    expect(named.services).toEqual(["api"]);
    expect(named.env.REGION).toBe("eu");
    expect(resolveProfile(c, "backend", []).services).toEqual(["auth", "api", "worker"]);
  });

  test("empty start uses the active profile, then the first profile, and never every service", () => {
    const c = cfg({ auth: [], api: [], extra: [] });
    c.profiles = {
      backend: { services: ["auth", "api"], environment: {} },
      full: { services: ["auth", "api", "extra"], environment: {} },
    };
    expect(firstProfileName(c)).toBe("backend");
    expect(resolveStartRequest(c, { activeProfile: "full" }).services).toEqual(["auth", "api", "extra"]);
    expect(resolveStartRequest(c, { profile: "backend" }).services).toEqual(["auth", "api"]);
    expect(resolveStartRequest(c, { services: ["extra"] }).services).toEqual(["extra"]);
    expect(resolveStartRequest(c, {}).profile).toBe("backend");
    const bare = cfg({ auth: [], api: [] });
    expect(() => resolveStartRequest(bare, {})).toThrow(/no profile or services/);
  });
});

describe("emptyRuntime", () => {
  test("produces a stopped runtime with no start time", () => {
    const rt = emptyRuntime("api");
    expect(rt.name).toBe("api");
    expect(rt.state).toBe("STOPPED");
    expect(rt.restarts).toBe(0);
    expect(rt.startTime).toBeUndefined();
  });
});

describe("supervisorRestartAdvice", () => {
  test("names `devctl down`, the only command that actually ends the daemon", () => {
    const advice = supervisorRestartAdvice(["logs", "plugins"]);
    expect(advice).toContain("logs, plugins");
    expect(advice).toContain("`devctl down && devctl start`");
  });

  // The regression this guards: `stop` was redefined to leave the daemon
  // running (only `down` ends it), but the two hand-written copies of this
  // advice — the daemon's reload log line and the CLI's reload note — kept
  // telling users to run `devctl stop && devctl start`, which restarts the
  // services and leaves the daemon holding the stale settings. Scanning the
  // sources catches a future copy that bypasses supervisorRestartAdvice()
  // the same way, which a unit test on the helper alone cannot.
  test("no source file advises the `devctl stop && devctl start` that cannot work", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "testdata") {
          continue;
        }
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) {
          continue;
        }
        if (readFileSync(path, "utf8").includes("devctl stop && devctl start")) {
          offenders.push(path);
        }
      }
    };
    walk(import.meta.dir);
    expect(offenders, "these files hand-write daemon-restart advice; call supervisorRestartAdvice() instead").toEqual([]);
  });
});
