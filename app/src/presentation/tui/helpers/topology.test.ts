import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyExpose, emptyWatch, type DevctlConfig } from "../../../domain/config/types.ts";
import { buildTopology, downstreamOf, upstreamOf } from "./topology.ts";

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

describe("buildTopology", () => {
  test("lays services out in dependency waves", () => {
    const model = buildTopology(cfg({ auth: [], api: ["auth"], worker: ["api"] }), "");
    expect(model.columns).toEqual([["auth"], ["api"], ["worker"]]);
    expect(model.cyclic).toBe(false);
  });

  test("builds an edge per dependency with its condition", () => {
    const c = cfg({ db: [], api: [] });
    c.services.api!.dependencies = [{ service: "db", condition: "service_healthy" }];
    const model = buildTopology(c, "");
    expect(model.edges).toContainEqual({ from: "db", to: "api", condition: "service_healthy" });
  });

  test("drops edges to unknown services", () => {
    const c = cfg({ api: ["ghost"] });
    const model = buildTopology(c, "");
    expect(model.edges).toEqual([]);
  });

  test("degrades to a single column on a dependency cycle instead of throwing", () => {
    const model = buildTopology(cfg({ a: ["b"], b: ["a"] }), "");
    expect(model.cyclic).toBe(true);
    expect(model.columns).toEqual([["a", "b"]]);
  });
});

describe("upstreamOf / downstreamOf", () => {
  const model = buildTopology(cfg({ auth: [], api: ["auth"], worker: ["api"], sidecar: ["api"] }), "");

  test("upstream is what a service depends on", () => {
    expect(upstreamOf(model.edges, "api").map((l) => l.name)).toEqual(["auth"]);
    expect(upstreamOf(model.edges, "auth")).toEqual([]);
  });

  test("downstream is the blast radius of a service", () => {
    expect(downstreamOf(model.edges, "api").map((l) => l.name)).toEqual(["sidecar", "worker"]);
    expect(downstreamOf(model.edges, "worker")).toEqual([]);
  });
});
