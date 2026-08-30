import { describe, expect, test } from "bun:test";
import { defaultConfig, type DevctlConfig } from "./config/types.ts";
import { resolveProfile, shutdownPlan, startupPlan } from "./services.ts";

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
      capabilities: [],
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

  test("shutdown reverses waves", () => {
    const plan = shutdownPlan(cfg({ auth: [], api: ["auth"] }), ["api"]);
    expect(plan.waves).toEqual([["api"], ["auth"]]);
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
});
