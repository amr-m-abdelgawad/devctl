import { profileId } from "../ids.ts";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyExpose, emptyProfile, emptyWatch, type DevctlConfig } from "../config/types.ts";
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
      environments: {},
      default_environment: "",
      health: { type: "", url: "", address: "", command: { args: [], shell: false }, interval_seconds: 0, timeout_seconds: 0, start_period_seconds: 0, unhealthy_threshold: 3, healthy_reset_threshold: 10 },
      identity: { type: "", mode: "", service_account: "" },
      logs: { stdout: false, stderr: false },
      restart: { policy: "", max_retries: 0, backoff_seconds: 0 },
      startup: { wait_for_healthy: false, timeout_seconds: 0 },
      hooks: { pre_start: { args: [], shell: false }, post_start: { args: [], shell: false } },
      capabilities: [],
      proxy: [],
      expose: emptyExpose(),
      watch: emptyWatch(),
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

  test("object dependency conditions preserve graph ordering", () => {
    const c = cfg({ db: [], api: [] });
    c.services.api!.dependencies = [{ service: "db", condition: "service_healthy" }];
    expect(startupPlan(c, ["api"], "").waves).toEqual([["db"], ["api"]]);
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

  test("implicit http recipe service refs become startup dependencies", () => {
    const c = cfg({ identity: [], worker: [] });
    c.services.identity!.health.type = "process";
    c.http.login = {
      request: {
        method: "POST",
        url: "${services.identity.url}/oauth/token",
        headers: {},
        body: "",
        form: {},
        auth: { type: "", identity: { type: "", service_account: "" }, audience: "", service_account: "", client_id: "", client_secret: "" },
        timeout_seconds: 0,
      },
      outputs: { token: "access_token" },
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    c.services.worker!.environment.vars.TOKEN = "${http.login.token}";
    const plan = startupPlan(c, ["worker"], "");
    expect(plan.waves).toEqual([["identity"], ["worker"]]);
    expect(plan.steps.find((step) => step.name === "worker")?.dependencies).toEqual([
      { service: "identity", condition: "service_healthy" },
    ]);
    expect(shutdownPlan(c, ["worker"]).waves).toEqual([["worker"]]);
  });

  test("a configured profile does not start omitted dependencies", () => {
    const c = cfg({ auth: [], api: ["auth"], worker: ["api"] });
    c.profiles.api_only = emptyProfile({ services: ["api"] });
    c.profiles.backend = emptyProfile({ services: ["auth", "api", "worker"] });
    expect(startupPlan(c, ["api"], "api_only").waves).toEqual([["api"]]);
    expect(startupPlan(c, ["worker"], "backend").waves).toEqual([["auth"], ["api"], ["worker"]]);
  });

  test("named start without a configured profile still expands dependencies", () => {
    const c = cfg({ auth: [], api: ["auth"] });
    expect(startupPlan(c, ["api"], "").waves).toEqual([["auth"], ["api"]]);
  });

  test("profile plus extra names clips deps to the profile union those names", () => {
    const c = cfg({ auth: [], api: ["auth"], worker: ["api"] });
    c.profiles.console = emptyProfile({ services: ["worker"] });
    expect(startupPlan(c, ["api"], "console").waves.flat().sort()).toEqual(["api"]);
  });

  test("leftover local env refs on a clipped profile become plan blockers", () => {
    const c = cfg({ identity: [], api: ["identity"] });
    c.services.api!.environment.vars.AUTH_URL = "${services.identity.url}";
    c.profiles.remote = emptyProfile({ services: ["api"] });
    const plan = startupPlan(c, ["api"], "remote");
    expect(plan.waves).toEqual([["api"]]);
    expect(plan.blockers?.[0]?.name).toBe("api");
    expect(plan.blockers?.[0]?.message).toContain("identity");
  });

  test("profile overlay bind and service_environment clear leftover local refs", () => {
    const c = cfg({ identity: [], api: ["identity"] });
    c.services.api!.environment.vars.AUTH_URL = "${services.identity.url}";
    c.services.api!.environments = {
      deployed: { vars: { AUTH_URL: "https://identity.example.com" }, required: [], defaults: {} },
      local: { vars: { AUTH_URL: "${services.identity.url}" }, required: [], defaults: {} },
    };
    c.services.api!.default_environment = "local";
    c.profiles.via_overlay = emptyProfile({ services: ["api"], environments: { api: "deployed" } });
    expect(startupPlan(c, ["api"], "via_overlay").blockers).toEqual([]);
    c.profiles.via_keys = emptyProfile({
      services: ["api"],
      service_environment: { api: { vars: { AUTH_URL: "https://identity.example.com" }, required: [], defaults: {} } },
    });
    expect(startupPlan(c, ["api"], "via_keys").blockers).toEqual([]);
  });
});

describe("resolveProfile", () => {
  test("named services do not pull in the rest of the profile", () => {
    const c = cfg({ auth: [], api: ["auth"], worker: ["api"] });
    c.profiles = { backend: emptyProfile({ services: ["auth", "api", "worker"], environment: { REGION: "eu" } }) };
    const named = resolveProfile(c, profileId("backend"), ["api"]);
    expect(named.services).toEqual(["api"]);
    expect(named.env.REGION).toBe("eu");
    expect(resolveProfile(c, profileId("backend"), []).services).toEqual(["auth", "api", "worker"]);
  });

  test("empty start uses the active profile, then the first profile, and never every service", () => {
    const c = cfg({ auth: [], api: [], extra: [] });
    c.profiles = {
      backend: emptyProfile({ services: ["auth", "api"] }),
      full: emptyProfile({ services: ["auth", "api", "extra"] }),
    };
    expect(firstProfileName(c)).toBe(profileId("backend"));
    expect(resolveStartRequest(c, { activeProfile: profileId("full") }).services).toEqual(["auth", "api", "extra"]);
    expect(resolveStartRequest(c, { profile: profileId("backend") }).services).toEqual(["auth", "api"]);
    expect(resolveStartRequest(c, { services: ["extra"] }).services).toEqual(["extra"]);
    expect(resolveStartRequest(c, {}).profile).toBe(profileId("backend"));
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
