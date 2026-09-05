import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../domain/config/types.ts";
import { emptyRuntime, HealthHealthy, HealthUnhealthy, HealthUnknown, StateFailed, StateStopped } from "../domain/service/services.ts";
import type { Clock } from "../ports/clock.ts";
import type { HealthCheckerFactory, HealthCheckResult } from "../ports/health-checker.ts";
import type { ContainerLaunchSpec, ProcessHandle, ProcessRuntime, ProcessSpec } from "../ports/process-runtime.ts";
import { Bus } from "../shared/events.ts";
import type { LifecycleSession } from "./lifecycle-session.ts";
import { ServiceOrchestrator } from "./orchestrator.ts";

const clock: Clock = { now: () => new Date(), isoNow: () => new Date().toISOString(), unixMs: () => Date.now() };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

class MemoryProcesses implements ProcessRuntime {
  readonly started: ProcessSpec[] = [];
  readonly containers: ContainerLaunchSpec[] = [];
  readonly hooks: string[] = [];
  private readonly handles = new Map<string, ProcessHandle>();
  isRunning(name: string): boolean { return this.handles.has(name); }
  async runOnce(spec: Omit<ProcessSpec, "onExit">): Promise<{ code: number; stdout: string; stderr: string }> {
    this.hooks.push(spec.name);
    return { code: 0, stdout: "", stderr: "" };
  }
  async startContainer(spec: ContainerLaunchSpec): Promise<ProcessHandle> {
    this.containers.push(spec);
    return this.start({ name: spec.name, args: spec.command, shell: false, workDir: spec.workDir, env: spec.env, graceMs: 0, onExit: spec.onExit });
  }
  async start(spec: ProcessSpec): Promise<ProcessHandle> {
    this.started.push(spec);
    const handle = { name: spec.name, pid: this.started.length, startTime: new Date(), workDir: spec.workDir, args: spec.args, done: new Promise<{ code: number }>(() => {}) };
    this.handles.set(spec.name, handle);
    return handle;
  }
  crash(name: string): void {
    this.handles.delete(name);
    this.started.findLast((spec) => spec.name === name)?.onExit?.(1);
  }
  async stop(name: string): Promise<void> { this.handles.delete(name); }
  get(name: string): ProcessHandle | undefined { return this.handles.get(name); }
  all(): ProcessHandle[] { return [...this.handles.values()]; }
}

function harness(checkers: HealthCheckerFactory = { lookup: () => undefined }) {
  const cfg = defaultConfig();
  cfg.proxy.enabled = false;
  const svc = cfg.services.api = emptyService();
  svc.command = { args: ["api"], shell: false };
  svc.startup.wait_for_healthy = false;
  svc.health.type = "";
  const processes = new MemoryProcesses();
  const orch = new ServiceOrchestrator(processes, clock);
  const assigned: string[] = [];
  const session: LifecycleSession = {
    cfg, profile: "", profileEnv: {}, detached: false, proxySuppressed: false,
    runtimes: new Map([["api", emptyRuntime("api")]]), ports: new Map(), clientEnv: new Map(),
    serviceProfile: new Map(), serviceProfileEnv: new Map(), processMeta: new Map(),
    containerPrefix: "devctl-test-", logs: { append: () => {} }, bus: new Bus(32), healthCheckers: checkers,
    prepareServiceIdentity: async () => {},
    resolveServiceExecution: async (_name, _svc, profile, env) => ({ env: { ...env, PROFILE: profile }, workDir: "/work" }),
    detectGoogle: async () => ({ adcAvailable: true }), startProxy: async () => {},
    fail: async (name) => {
      orch.health.clearHealthWatch(name);
      orch.health.clearRestartTimer(name);
      orch.health.bumpGeneration(name);
      await processes.stop(name);
      session.setState(name, StateFailed, HealthUnknown, 0, "failed");
    },
    claimIfAlreadyUp: async (name) => processes.isRunning(name),
    assignPendingPorts: async (pending) => { assigned.push(...pending); },
    setState: (name, state, health, pid, last_error) => {
      const rt = session.runtimes.get(name) ?? emptyRuntime(name);
      Object.assign(rt, { state, health, pid, last_error });
      session.runtimes.set(name, rt);
    },
    persistState: () => {}, log: () => {}, releasePorts: async () => {},
    forgetService: (name) => { orch.health.forget(name); session.runtimes.delete(name); },
  };
  orch.bind(session);
  cleanups.push(() => orch.health.dispose());
  return { cfg, svc, processes, orch, session, assigned };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(2);
  expect(predicate()).toBe(true);
}

describe("ServiceOrchestrator", () => {
  test("plans startup waves without touching processes", () => {
    const { orch, cfg, processes } = harness();
    expect(orch.planStart(cfg, ["api"], "").waves.flat()).toEqual(["api"]);
    expect(processes.started).toHaveLength(0);
  });

  test("starts processes and runs explicit-start hooks through the process port", async () => {
    const { orch, svc, processes, assigned } = harness();
    svc.hooks.pre_start = { args: ["before"], shell: false };
    svc.hooks.post_start = { args: ["after"], shell: false };
    expect((await orch.start({ services: ["api"] })).waves.flat()).toEqual(["api"]);
    expect(processes.started.map((s) => s.name)).toEqual(["api"]);
    expect(processes.hooks).toEqual(["api:pre_start", "api:post_start"]);
    expect(assigned).toEqual(["api"]);
  });

  test("container launch uses its runtime configuration and process health", async () => {
    const { orch, svc, session, processes } = harness({ lookup: () => { throw new Error("host probe must not check a container pid"); } });
    svc.container = { runtime: "podman", image: "test:local", env: { FLAG: "container" }, ports: { http: 80 }, volumes: ["/data:/data"] };
    svc.health.type = "process";
    session.ports.set("api", { http: 8080 });
    await orch.start({ services: ["api"] });
    await until(() => session.runtimes.get("api")?.health === HealthHealthy);
    expect(processes.containers[0]).toMatchObject({
      runtime: "podman", containerName: "devctl-test-api", image: "test:local",
      command: ["api"], env: { PROFILE: "", FLAG: "container" },
      ports: { http: 8080 }, targetPorts: { http: 80 }, volumes: ["/data:/data"],
    });
  });

  test("stopping during a post-start hook cannot reinstall health monitoring", async () => {
    const { orch, svc, session, processes } = harness();
    let release!: () => void;
    svc.hooks.post_start = { args: ["after"], shell: false };
    processes.runOnce = async () => {
      await new Promise<void>((done) => { release = done; });
      return { code: 0, stdout: "", stderr: "" };
    };
    const started = orch.start({ services: ["api"] });
    await until(() => release !== undefined);
    await orch.stop(["api"]);
    release();
    await started;
    expect(session.runtimes.get("api")?.state).toBe(StateStopped);
    expect(session.runtimes.get("api")?.health).toBe(HealthUnknown);
  });

  test("stop unknown service fails closed", async () => {
    await expect(harness().orch.stop(["missing"])).rejects.toThrow(/unknown service/);
  });

  test("uses an injected checker with the launch environment and assigned ports", async () => {
    const observed: unknown[] = [];
    const { orch, svc, session } = harness({ lookup: () => ({ check: async (_cfg, ctx) => {
      observed.push(ctx); return { status: HealthHealthy, message: "ready" };
    } }) });
    svc.health.type = "custom";
    session.ports.set("api", { http: 1234 });
    await orch.start({ services: ["api"] });
    await until(() => session.runtimes.get("api")?.health === HealthHealthy);
    expect(observed[0]).toEqual({ pid: 1, ports: { http: 1234 }, workDir: "/work", env: { PROFILE: "" } });
  });

  test("crash restart preserves the service profile and skips hooks", async () => {
    const { orch, cfg, svc, session, processes } = harness();
    cfg.profiles.backend = { services: ["api"], environment: { MARKER: "original" } };
    svc.restart = { enabled: true, policy: "on_failure", max_retries: 2, backoff_seconds: 0.01 };
    svc.hooks.pre_start = { args: ["before"], shell: false };
    await orch.start({ services: ["api"], profile: "backend" });
    session.profile = "unrelated";
    session.profileEnv = { MARKER: "changed" };
    processes.crash("api");
    await until(() => processes.started.length === 2);
    expect(processes.started[1]?.env).toEqual({ MARKER: "original", PROFILE: "backend" });
    expect(processes.hooks).toEqual(["api:pre_start"]);
    expect(session.runtimes.get("api")?.restarts).toBe(1);
  });

  test("explicit stop cancels a scheduled crash restart", async () => {
    const { orch, svc, processes, session } = harness();
    svc.restart = { enabled: true, policy: "always", max_retries: 2, backoff_seconds: 0.02 };
    await orch.start({ services: ["api"] });
    processes.crash("api");
    await orch.stop(["api"]);
    await Bun.sleep(40);
    expect(processes.started).toHaveLength(1);
    expect(session.runtimes.get("api")?.state).toBe(StateStopped);
  });

  test("unhealthy restarts consume the shared retry budget", async () => {
    const { orch, svc, processes, session } = harness({ lookup: () => ({ check: async () => ({ status: HealthUnhealthy, message: "down" }) }) });
    svc.health.type = "custom";
    svc.health.interval_seconds = 0.005;
    svc.health.unhealthy_threshold = 1;
    svc.health.start_period_seconds = 0;
    svc.restart = { enabled: true, policy: "on_failure", max_retries: 2, backoff_seconds: 0.01 };
    await orch.start({ services: ["api"] });
    await until(() => processes.started.length === 3);
    await Bun.sleep(40);
    expect(processes.started).toHaveLength(3);
    expect(session.runtimes.get("api")?.restarts).toBe(2);
  });

  test("a throwing checker is reported as unhealthy", async () => {
    const { orch, svc, session } = harness({ lookup: () => ({ check: () => { throw new Error("probe failed"); } }) });
    svc.health.type = "custom";
    svc.health.start_period_seconds = 0;
    await orch.start({ services: ["api"] });
    await until(() => session.runtimes.get("api")?.health === HealthUnhealthy);
  });

  test("forgetting and re-adding a service invalidates a slow health result", async () => {
    let resolve!: (result: HealthCheckResult) => void;
    let calls = 0;
    const { orch, svc, session } = harness({ lookup: () => ({ check: async () => {
      calls++;
      return calls === 1 ? new Promise<HealthCheckResult>((done) => { resolve = done; }) : { status: HealthHealthy, message: "new process" };
    } }) });
    svc.health.type = "custom";
    svc.health.interval_seconds = 60;
    svc.health.start_period_seconds = 0;
    await orch.start({ services: ["api"] });
    await until(() => calls === 1);
    await orch.stop(["api"]);
    session.forgetService("api");
    await orch.start({ services: ["api"] });
    await until(() => session.runtimes.get("api")?.health === HealthHealthy);
    resolve({ status: HealthUnhealthy, message: "stale" });
    await Bun.sleep(5);
    expect(session.runtimes.get("api")?.health).toBe(HealthHealthy);
  });

  test("disposing a detached monitor invalidates in-flight probes", async () => {
    let resolve!: (result: HealthCheckResult) => void;
    const { orch, svc, session, processes } = harness({ lookup: () => ({ check: () => new Promise((done) => { resolve = done; }) }) });
    svc.health.type = "custom";
    svc.health.start_period_seconds = 0;
    await orch.start({ services: ["api"] });
    orch.health.dispose();
    resolve({ status: HealthUnhealthy, message: "late" });
    await Bun.sleep(5);
    expect(session.runtimes.get("api")?.health).toBe(HealthUnknown);
    expect(processes.isRunning("api")).toBe(true);
  });
});
