import { profileId } from "../domain/ids.ts";
import { HealthMonitor } from "./health-monitor.ts";
import { ServiceStarted, ServiceFailed, ServiceStopped, newEvent } from "../shared/events.ts";
import { graceSeconds, type DevctlConfig, commandEmpty, captureStdout, captureStderr, dependencyCondition, dependencyName, type Command } from "../domain/config/types.ts";
import { KindGeneral, KindHealthCheck, KindProcessStart, KindServiceNotFound, humanMessage, newError } from "../shared/errors.ts";
import { identityBlockers } from "../domain/identity/identity.ts";
import { canTransition, transition } from "../domain/service/lifecycle.ts";
import { DEFAULT_STARTUP_TIMEOUT_MS, StartupPolicy } from "../domain/service/policies.ts";
import { resolvedContainerLimits } from "../domain/service/container-limits.ts";
import { scopeVolumes } from "../domain/service/container-volumes.ts";
import {
  HealthHealthy,
  StateHealthy,
  StateStarting,
  StateRunning,
  StateFailed,
  StateRestarting,
  HealthUnknown,
  StateStopped,
  StateStopping,
  StateUnknown,
  dependentsClosure,
  profileEnvironment,
  resolveStartRequest,
  shutdownPlan,
  shutdownPlanExact,
  startupPlan,
  type Plan,
  type ServiceState,
} from "../domain/service/services.ts";
import type { Clock } from "../ports/clock.ts";
import type { ProcessRuntime } from "../ports/process-runtime.ts";
import type { StartRequest } from "../domain/status.ts";
import type { ServiceOrchestratorPort } from "../ports/daemon.ts";
import type { LifecycleSession } from "../ports/lifecycle-session.ts";
import { recipesNeededForEnv } from "../domain/http/recipes.ts";
import { effectiveServiceEnv, overlayEnv, profileBoundOverlay, profileServiceEnvConfig, resolveEnvironmentName } from "../domain/service/environments.ts";

const HEALTH_POLL_MS = 100;

export class ServiceOrchestrator implements ServiceOrchestratorPort {
  private session?: LifecycleSession;
  readonly health: HealthMonitor;

  constructor(
    readonly processes: ProcessRuntime,
    readonly clock: Clock,
  ) {
    this.health = new HealthMonitor(() => this.host(), processes, clock, {
      startOne: (name, profile, env, hooks) => this.startOne(name, profile, env, hooks),
      restart: (names, opts) => this.restart(names, opts),
    });
  }

  bind(session: LifecycleSession): void {
    this.session = session;
  }

  private host(): LifecycleSession {
    if (!this.session) {
      throw newError(KindProcessStart, "service orchestrator is not bound");
    }
    return this.session;
  }

  planStart(cfg: DevctlConfig, selected: string[], profile: string): Plan {
    return startupPlan(cfg, selected, profile);
  }

  planStop(cfg: DevctlConfig, selected: string[], exact = false): Plan {
    return exact ? shutdownPlanExact(cfg, selected) : shutdownPlan(cfg, selected);
  }

  applyLifecycle(from: ServiceState, to: ServiceState): ServiceState {
    return transition(from, to);
  }

  isLegalLifecycle(from: ServiceState, to: ServiceState): boolean {
    return canTransition(from, to);
  }

  async start(req: StartRequest): Promise<Plan> {
    const s = this.host();
    if (req.detach === true) {
      s.detached = true;
    }
    const resolved = resolveStartRequest(s.cfg, {
      services: req.services,
      profile: req.profile ? profileId(req.profile) : undefined,
      activeProfile: profileId(s.profile),
    });
    if (resolved.profile) {
      s.profile = resolved.profile;
      s.profileEnv = resolved.env;
    }
    // Only a request that actually carries a client_env replaces the stored
    // fallback for these services — an MCP-initiated or internally-triggered
    // start (never a real client) must not blank out an earlier real one.
    if (req.client_env) {
      for (const name of resolved.services) {
        s.clientEnv.set(name, req.client_env);
      }
    }
    const extra = req.extra_env && Object.keys(req.extra_env).length > 0 ? req.extra_env : undefined;
    const extraTargets = extra === undefined ? undefined : new Set(extraEnvTargets(req, resolved.services));
    // A real start request forgives past restarts for everything it names —
    // see resetRestartCount. `auto` marks a start restart() issued for its
    // own automatic (health-triggered) relaunch, which must preserve the
    // count armRestart's caller just bumped rather than immediately erase it.
    if (req.auto !== true) {
      for (const name of resolved.services) {
        this.health.resetRestartCount(name);
      }
    }
    const plan = this.planStart(s.cfg, resolved.services, resolved.profile);
    const google = await s.detectGoogle(s.cfg.google.project_id);
    plan.blockers = [...(plan.blockers ?? []), ...identityBlockers(s.cfg, plan.waves.flat(), google.adcAvailable)];
    if (s.cfg.proxy.enabled && !s.proxySuppressed) {
      // A proxy that cannot bind blocks the start: its configured address
      // (and the token endpoint's) is held by some other process — often
      // another checkout's devctl — and services started now would send
      // their traffic and internal token there.
      const proxyError = await s.startProxy().then(
        () => undefined,
        (err: unknown) => humanMessage(err),
      );
      if (proxyError !== undefined) {
        s.log("devctl", "ERROR", `proxy failed to start: ${proxyError}`);
        // Services already live keep running: blocking goes through fail(),
        // which would kill them.
        const already = new Set(plan.blockers.map((blocker) => blocker.name));
        for (const name of plan.waves.flat()) {
          const state = s.runtimes.get(name)?.state ?? StateStopped;
          if (!already.has(name) && (state === StateStopped || state === StateFailed || state === StateUnknown)) {
            plan.blockers.push({ name, message: `proxy failed to start (${proxyError}); free the port, change proxy.listen, or run devctl proxy stop to start without it` });
          }
        }
      }
    }
    const blocked = new Set(plan.blockers.map((blocker) => blocker.name));
    for (const blocker of plan.blockers) {
      await s.fail(blocker.name, newError(KindProcessStart, blocker.message));
    }
    const pending: string[] = [];
    for (const name of plan.waves.flat()) {
      if (blocked.has(name) || (await s.claimIfAlreadyUp(name))) {
        continue;
      }
      pending.push(name);
    }
    // Record profile only for names we are about to spawn. Claiming an
    // already-running process must not rewrite the stored name — `start api
    // --profile frontend` against a live backend process would otherwise
    // remember frontend without applying it, and a later crash restart
    // would switch environments. Restart and a start that omitted profile
    // reuse stored per-service context. RPC/MCP often send profile as ""
    // when the client omitted it; that must not look like an explicit
    // request to clear the stored name.
    for (const name of pending) {
      if (req.profile || !s.serviceProfile.has(name)) {
        s.serviceProfile.set(name, resolved.profile);
      }
    }
    if (pending.length > 0) {
      await s.assignPendingPorts(pending);
    }
    for (let i = 0; i < plan.waves.length; i += 1) {
      const wave = plan.waves[i] ?? [];
      const launch = wave.filter((name) => pending.includes(name));
      if (launch.length > 0) {
        const results = await Promise.allSettled(launch.map((name) => this.startOne(name, resolved.profile, resolved.env, req.auto !== true, extra && extraTargets?.has(name) ? extra : undefined)));
        let waveFailed = false;
        for (const result of results) {
          if (result.status === "rejected") {
            waveFailed = true;
            s.log("devctl", "ERROR", humanMessage(result.reason));
          }
        }
        if (waveFailed) {
          throw newError(KindProcessStart, "one or more services failed to start");
        }
      }
      // Later waves wait only for service_healthy edges into this one.
      // The last wave only waits inside startOne when wait_for_healthy is
      // set — otherwise start() would refuse to return while a service was
      // still UNHEALTHY and retrying.
      if (i < plan.waves.length - 1) {
        try {
          const remaining = plan.waves.slice(i + 1).flat();
          await this.awaitWaveHealth(wave.filter((name) => !blocked.has(name)), remaining, plan);
        } catch (err) {
          s.log("devctl", "ERROR", humanMessage(err));
          throw err;
        }
      }
    }
    s.persistState();
    return plan;
  }

  async stop(names: string[]): Promise<void> {
    const s = this.host();
    let selected = names;
    if (selected.length === 0) {
      selected = [...s.runtimes.entries()]
        .filter(([, rt]) => rt.state !== StateStopped)
        .map(([name]) => name);
    }
    if (selected.length === 0) {
      return;
    }
    // An orphaned service (removed from configuration by a reload while
    // still running) has no dependency graph left to plan against; only a
    // genuinely unknown name should still fail closed.
    const orphaned = selected.filter((name) => !s.cfg.services[name] && s.runtimes.has(name));
    const trulyUnknown = selected.filter((name) => !s.cfg.services[name] && !s.runtimes.has(name));
    if (trulyUnknown.length > 0) {
      throw newError(KindServiceNotFound, `unknown service "${trulyUnknown[0]}"`);
    }
    const known = selected.filter((name) => s.cfg.services[name] !== undefined);
    if (known.length > 0) {
      await this.runStopPlan(this.planStop(s.cfg, known), { resetRestartCounts: true });
    }
    if (orphaned.length > 0) {
      await this.runStopPlan({ profile: s.profile, steps: [], waves: orphaned.map((name) => [name]) }, { resetRestartCounts: true });
      for (const name of orphaned) {
        s.forgetService(name);
      }
    }
  }

  async restart(names: string[], opts?: { cascade?: boolean; clientEnv?: Record<string, string>; auto?: boolean }): Promise<void> {
    const s = this.host();
    const cascade = opts?.cascade === true;
    const targets = cascade ? dependentsClosure(s.cfg, names) : names;
    const plan = cascade ? this.planStop(s.cfg, names) : this.planStop(s.cfg, names, true);
    const manual = opts?.auto !== true;
    await this.runStopPlan(plan, { resetRestartCounts: manual });
    await this.start({ services: targets, client_env: opts?.clientEnv, auto: opts?.auto });
  }

  async runStopPlan(plan: Plan, opts?: { resetRestartCounts?: boolean }): Promise<void> {
    const s = this.host();
    // A crash or unhealthy restart scheduled just before this call must not
    // go on to revive a service the caller explicitly asked to stop.
    // Bumping the generation also invalidates any exit/health callback still
    // in flight from the process this call is about to kill.
    for (const name of plan.waves.flat()) {
      this.health.clearRestartTimer(name);
      this.health.bumpGeneration(name);
      if (opts?.resetRestartCounts) {
        this.health.resetRestartCount(name);
      }
    }
    const grace = graceSeconds(s.cfg.shutdown) * 1000;
    const failures: string[] = [];
    for (const wave of plan.waves) {
      // allSettled, not all: one service that fails to stop must not strand
      // every later wave untouched behind it.
      const results = await Promise.allSettled(
        wave.map(async (name) => {
          s.setState(name, StateStopping, HealthUnknown, 0, "");
          this.health.clearHealthWatch(name);
          try {
            await this.processes.stop(name, grace);
          } catch (err) {
            s.setState(name, StateFailed, HealthUnknown, 0, humanMessage(err));
            s.bus.publish(newEvent(ServiceFailed, name, { error: humanMessage(err) }));
            throw err;
          }
          try {
            await s.releasePorts(name);
          } catch (err) {
            s.log(name, "WARN", humanMessage(err));
          }
          s.setState(name, StateStopped, HealthUnknown, 0, "");
          s.bus.publish(newEvent(ServiceStopped, name, {}));
        }),
      );
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        if (result?.status === "rejected") {
          const name = wave[i] ?? "";
          failures.push(name);
          s.log(name || "devctl", "ERROR", humanMessage(result.reason));
        }
      }
    }
    s.persistState();
    if (failures.length > 0) {
      throw newError(KindProcessStart, `failed to stop: ${failures.join(", ")}`);
    }
  }

  serviceIsActive(name: string): boolean {
    if (this.processes.isRunning(name)) {
      return true;
    }
    const current = this.host().runtimes.get(name);
    if (!current) {
      return false;
    }
    if (
      current.state === StateRestarting ||
      current.state === StateStopping ||
      current.state === StateStopped ||
      current.state === StateFailed
    ) {
      return false;
    }
    if (current.health === HealthHealthy || current.state === StateHealthy) {
      return true;
    }
    // RESTARTING has no live process (pid is cleared in onExit) — it must not
    // count as active, or the scheduled restart's startOne() call would see
    // itself as already up and bail out without ever spawning a new process.
    return current.state === StateStarting || current.state === StateRunning;
  }

  private async startOne(name: string, profile: string, profileEnv: Record<string, string>, runHooks = false, extraEnv?: Record<string, string>): Promise<void> {
    const s = this.host();
    if (this.serviceIsActive(name)) {
      return;
    }
    const svc = s.cfg.services[name];
    if (!svc) {
      throw newError(KindGeneral, `unknown service ${name}`);
    }
    s.setState(name, StateStarting, HealthUnknown, 0, "");
    const gen = this.health.bumpGeneration(name);
    const launchProfile = s.serviceProfile.get(name) ?? profile;
    const launchEnv = launchProfile !== "" ? profileEnvironment(s.cfg, launchProfile) : { ...profileEnv };
    s.serviceProfileEnv.set(name, launchEnv);
    const bound = profileBoundOverlay(s.cfg, launchProfile, name);
    const envName = resolveEnvironmentName(svc, bound !== "" ? bound : s.serviceEnv.get(name));
    if (bound !== "") {
      s.serviceEnv.set(name, envName);
    }
    const launchService = envName === "" ? svc : { ...svc, environment: effectiveServiceEnv(svc, envName) };
    const profileSvcEnv = profileServiceEnvConfig(s.cfg, launchProfile, name);
    const recipeEnv = overlayEnv(launchService.environment, profileSvcEnv);
    let assigned: Record<string, number> = {};
    let env: Record<string, string> = {};
    let workDir = "";
    let handle!: Awaited<ReturnType<ProcessRuntime["start"]>>;
    try {
      await s.prepareServiceIdentity(name, svc);
      assigned = s.ports.get(name) ?? {};
      const needed = recipesNeededForEnv(s.cfg, recipeEnv, launchEnv);
      if (needed.length > 0) {
        await s.ensureHttpRecipes(needed);
      }
      const stored = s.clientEnv.get(name);
      const launchClientEnv = extraEnv ? { ...(stored ?? {}), ...extraEnv } : stored;
      const resolved = await s.resolveServiceExecution(name, launchService, launchProfile, launchEnv, launchClientEnv, !svc.container, envName);
      env = resolved.env;
      workDir = resolved.workDir;
      if (runHooks) {
        await this.runTransient(`${name}:pre_start`, svc.hooks.pre_start, svc.shell, workDir, env);
      }
      // Identity resolution, env resolution, and pre_start can each take long
      // enough for a stop()/restart() to land on this same name in the
      // meantime — bumping the generation past `gen`. Spawning anyway would
      // resurrect a service the caller already believes is stopped and
      // silently undo that call's result, so bail out here instead.
      if (!this.health.isCurrentGeneration(name, gen)) {
        return;
      }
      const onLine = (stream: "stdout" | "stderr", line: string): void => {
        s.logs.append({
          timestamp: this.clock.isoNow(), service: name, source: stream, stream,
          level: "", message: line, pid: handle.pid,
        });
      };
      const onExit = (code: number, err?: Error): void => this.health.onExit(name, gen, code, err);
      const mounts = svc.container ? scopeVolumes(svc.container, s.containerPrefix) : undefined;
      handle = svc.container
        ? await this.processes.startContainer({
            name,
            runtime: svc.container.runtime === "podman" ? "podman" : "docker",
            containerName: `${s.containerPrefix}${name.replace(/[^a-zA-Z0-9_.-]/g, "-")}`,
            image: svc.container.image,
            command: [...svc.command.args],
            env: { ...env, ...svc.container.env },
            ports: assigned,
            targetPorts: svc.container.ports,
            volumes: mounts?.volumes ?? [],
            seeds: mounts?.seeds ?? [],
            workDir,
            limits: resolvedContainerLimits(svc.container),
            onLine,
            onExit,
          })
        : await this.processes.start({
            name,
            args: [...svc.command.args],
            shell: svc.shell || svc.command.shell,
            workDir,
            env,
            graceMs: graceSeconds(s.cfg.shutdown) * 1000,
            captureStdout: captureStdout(svc),
            captureStderr: captureStderr(svc),
            onLine,
            onExit,
          });
    } catch (err) {
      if (this.health.isCurrentGeneration(name, gen)) {
        s.serviceStartedEnv.delete(name);
        await s.fail(name, err);
      }
      throw err;
    }
    if (!this.health.isCurrentGeneration(name, gen)) {
      // A stop()/restart() landed on this name in the instant between the
      // check above and this spawn actually completing. Only clean up if
      // the handle we just got is still the one on record for this name —
      // procs.start()/startContainer() hand back an already-running
      // replacement instead of spawning when a newer call beat this one to
      // it, and that replacement must be left alone.
      if (this.processes.get(name) === handle) {
        await this.processes.stop(name, graceSeconds(s.cfg.shutdown) * 1000).catch(() => {});
      }
      s.serviceStartedEnv.delete(name);
      return;
    }
    s.serviceStartedEnv.set(name, envName);
    s.processMeta.set(name, { command: [...svc.command.args], cwd: workDir, startTime: handle.startTime });
    s.setState(name, StateRunning, HealthUnknown, handle.pid, "");
    s.bus.publish(newEvent(ServiceStarted, name, { pid: handle.pid }));
    if (runHooks) {
      try {
        await this.runTransient(`${name}:post_start`, svc.hooks.post_start, svc.shell, workDir, env);
      } catch (err) {
        await s.fail(name, err);
        throw err;
      }
    }
    if (!this.health.isCurrentGeneration(name, gen)) return;
    this.health.startHealth(name, svc, handle.pid, assigned, workDir, env, gen);
    // Persist and drop restart_required right after a successful spawn —
    // not batched at the end of start()'s whole plan — so a crash-restart's
    // respawn (which never goes through start() at all) and an earlier
    // wave's processes both survive a later wave or health wait failing.
    // Claiming an already-running process never reaches here, so a stale
    // process does not lose its restart_required warning.
    s.persistState();
    s.clearRestartRequired([name]);
    if (StartupPolicy.waitForHealthy(svc)) {
      const timeout = StartupPolicy.timeoutMs(svc, DEFAULT_STARTUP_TIMEOUT_MS);
      try {
        await this.waitHealthy(name, timeout);
      } catch (err) {
        await s.fail(name, err);
        throw err;
      }
    }
  }

  private async awaitWaveHealth(wave: string[], remaining: string[], plan: Plan): Promise<void> {
    for (const name of namesNeedingHealthWait(wave, remaining, plan)) {
      const svc = this.host().cfg.services[name];
      if (!svc || svc.health.type === "") {
        continue;
      }
      const timeout = StartupPolicy.timeoutMs(svc, DEFAULT_STARTUP_TIMEOUT_MS);
      try {
        await this.waitHealthy(name, timeout);
      } catch (err) {
        await this.host().fail(name, err);
        throw err;
      }
    }
  }

  private async waitHealthy(name: string, timeout: number): Promise<void> {
    const deadline = this.clock.unixMs() + timeout;
    while (this.clock.unixMs() < deadline) {
      const rt = this.host().runtimes.get(name);
      if (rt?.health === HealthHealthy) {
        return;
      }
      if (rt?.state === StateFailed) {
        throw newError(KindHealthCheck, `service ${name} failed while waiting for healthy`);
      }
      await sleep(HEALTH_POLL_MS);
    }
    throw newError(KindHealthCheck, `service ${name} did not become healthy in time`);
  }

  private async runTransient(name: string, command: Command, shell: boolean, workDir: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    if (commandEmpty(command)) return { code: 0, stdout: "", stderr: "" };
    this.host().log(name, "INFO", `running ${command.args.join(" ")}`);
    const result = await this.processes.runOnce({
      name, args: [...command.args], shell: shell || command.shell, workDir, env,
      graceMs: graceSeconds(this.host().cfg.shutdown) * 1000,
      onLine: (stream, line) => this.host().logs.append({ timestamp: this.clock.isoNow(), service: name, source: stream, stream, level: "", message: line, pid: 0 }),
    });
    if (result.code !== 0) throw newError(KindProcessStart, `${name} exited with code ${result.code}`);
    return result;
  }
}

function namesNeedingHealthWait(wave: string[], remaining: string[], plan: Plan): string[] {
  const later = new Set(remaining);
  const inWave = new Set(wave);
  const needed = new Set<string>();
  for (const step of plan.steps) {
    if (!later.has(step.name)) {
      continue;
    }
    for (const dep of step.dependencies) {
      if (dependencyCondition(dep) !== "service_healthy") {
        continue;
      }
      const depName = dependencyName(dep);
      if (inWave.has(depName)) {
        needed.add(depName);
      }
    }
  }
  return [...needed];
}

function extraEnvTargets(req: StartRequest, resolved: string[]): string[] {
  const named = (req.services ?? []).filter((name) => name !== "");
  if (named.length === 0) {
    return resolved;
  }
  const allowed = new Set(resolved);
  return named.filter((name) => allowed.has(name));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
