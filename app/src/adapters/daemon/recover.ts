import type { DevctlConfig, ServiceConfig } from "../config/index.ts";
import { listenAddress } from "../config/index.ts";
import { envList, resolveEnvironment, runtimeForService } from "../environment/environment.ts";
import { effectiveServiceEnv, resolveEnvironmentName, serviceHasNamedEnvironments } from "../../domain/service/environments.ts";
import { secretManagerFetcher } from "../google/secret-manager.ts";
import { profileEnvironment, HealthUnknown, StateRunning, type Runtime, type ServiceHealth, type ServiceState } from "../../domain/service/services.ts";
import type { Clock } from "../../ports/clock.ts";
import type { ServiceOrchestratorPort } from "../../ports/daemon.ts";
import { humanMessage } from "../../shared/errors.ts";
import { SessionRecovered, newEvent, type Bus } from "../../shared/events.ts";
import { occupiedFixedPorts, findPortHolder } from "../net/ports.ts";
import type { Registry } from "../plugins/registry.ts";
import { type ProcessManager, sameAdoptedProcess, type ProcessIdentity } from "../process/processes.ts";
import type { ProxyServer, TokenEndpoint } from "../proxy/proxy.ts";
import { readPersistedState, repoID } from "../storage/storage.ts";
import type { TokenManager } from "../google/token.ts";
import type { LogStore } from "../../ports/log-store.ts";

export type RecoverHost = {
  cfg: DevctlConfig;
  profile: string;
  profileEnv: Record<string, string>;
  readonly runtimes: Map<string, Runtime>;
  readonly ports: Map<string, Record<string, number>>;
  readonly processMeta: Map<string, { command: string[]; cwd: string; startTime: Date }>;
  readonly serviceProfile: Map<string, string>;
  readonly serviceProfileEnv: Map<string, Record<string, string>>;
  readonly serviceEnv: Map<string, string>;
  readonly serviceStartedEnv: Map<string, string>;
  readonly orchestrator: ServiceOrchestratorPort;
  readonly procs: ProcessManager;
  readonly logs: Pick<LogStore, "append">;
  readonly clock: Clock;
  readonly tokens: TokenManager;
  readonly registry?: Registry;
  readonly proxy?: ProxyServer;
  readonly tokenEP?: TokenEndpoint;
  readonly boundTokenURL: string;
  readonly internalTok: string;
  readonly bus: Bus;
  inspectProcessFn(pid: number): Promise<ProcessIdentity | undefined>;
  processAliveFn(pid: number): boolean;
  serviceWorkDir(svc: ServiceConfig): string;
  persistState(): void;
  setState(name: string, state: ServiceState, health: ServiceHealth, pid: number, lastError: string): void;
  log(service: string, level: string, message: string): void;
  configOverlay?: string;
  sopsValues: Record<string, string>;
};

export async function resolveAdoptedHealthEnv(
  host: RecoverHost,
  name: string,
  svc: ServiceConfig,
  assigned: Record<string, number>,
): Promise<Record<string, string>> {
  let proxyURL = "";
  if (host.proxy?.isRunning()) {
    proxyURL = `http://${host.proxy.address()}`;
  } else if (host.cfg.proxy.enabled) {
    proxyURL = `http://${listenAddress(host.cfg.proxy.listen)}`;
  }
  const runtimeEnv = runtimeForService(name, "127.0.0.1", assigned, proxyURL, host.cfg.project.name);
  runtimeEnv.DEVCTL_INTERNAL_TOKEN = host.internalTok;
  if (host.cfg.proxy.token_endpoint.enabled) {
    runtimeEnv.DEVCTL_TOKEN_URL = host.boundTokenURL || `http://127.0.0.1:${host.tokenEP?.listenPort() || host.cfg.proxy.token_endpoint.port}/token`;
  }
  try {
    const envName = resolveEnvironmentName(svc, host.serviceStartedEnv.get(name) ?? host.serviceEnv.get(name));
    const serviceCfg = envName === "" ? svc : { ...svc, environment: effectiveServiceEnv(svc, envName) };
    const env = await resolveEnvironment(host.cfg.repoRoot, {
      service: name,
      profile: host.serviceProfile.get(name) ?? host.profile,
      serviceCfg,
      profileEnv: host.serviceProfileEnv.get(name) ?? host.profileEnv,
      assignedPorts: assigned,
      runtime: runtimeEnv,
      cfg: host.cfg,
      http: undefined,
      sourceValues: { sops: host.sopsValues },
      fetchSecret: secretManagerFetcher(async () => (await host.tokens.get("user", "", [])).accessToken),
      pluginSources: host.registry?.environmentSources,
    });
    return envList(env);
  } catch (err) {
    host.log(name, "WARN", `could not fully reconstruct environment for adopted service's health check (${humanMessage(err)}); using a baseline environment`);
    return envList(runtimeEnv);
  }
}

export function attachProcess(host: RecoverHost, name: string, pid: number, args: string[], workDir: string, startTime: Date): number | undefined {
  if (host.procs.get(name) && host.processAliveFn(host.procs.get(name)?.pid ?? 0)) {
    return undefined;
  }
  if (!host.processAliveFn(pid) || pid === process.pid) {
    return undefined;
  }
  const gen = host.orchestrator.health.bumpGeneration(name);
  try {
    host.procs.adopt({
      name,
      pid,
      args,
      workDir,
      startTime,
      onExit: (code, err) => {
        host.orchestrator.health.onExit(name, gen, code, err);
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    host.log(name, "WARN", `adopt pid ${pid} failed (${detail}); tracking leftover in snapshot only`);
  }
  host.processMeta.set(name, { command: args, cwd: workDir, startTime });
  host.persistState();
  return gen;
}

export async function claimIfAlreadyUp(host: RecoverHost, name: string): Promise<boolean> {
  const svc = host.cfg.services[name];
  if (host.orchestrator.serviceIsActive(name)) {
    if (svc && !host.ports.has(name)) {
      const occupied = await occupiedFixedPorts(svc);
      if (occupied) {
        host.ports.set(name, occupied);
      }
    }
    return true;
  }
  if (!svc) {
    return false;
  }
  if (svc.container) {
    const gen = host.orchestrator.health.bumpGeneration(name);
    const runtime = svc.container.runtime === "podman" ? "podman" : "docker";
    const workDir = host.serviceWorkDir(svc);
    const handle = await host.procs.adoptContainer({
      name,
      runtime,
      containerName: `devctl-${repoID(host.cfg.repoRoot)}-${name.replace(/[^a-zA-Z0-9_.-]/g, "-")}`,
      workDir,
      onLine: (stream, line) => host.logs.append({ timestamp: host.clock.isoNow(), service: name, source: stream, stream, level: "", message: line, pid: 0 }),
      onExit: (code, err) => host.orchestrator.health.onExit(name, gen, code, err),
    });
    if (!handle) return false;
    const assigned = host.ports.get(name) ?? Object.fromEntries(svc.ports.filter((port) => !port.auto).map((port) => [port.name, port.value]));
    host.ports.set(name, assigned);
    host.processMeta.set(name, { command: [...svc.command.args], cwd: workDir, startTime: handle.startTime });
    const rec = readPersistedState(host.cfg.repoRoot)?.processes.find((item) => item.name === name);
    rememberLaunchContext(host, name, persistedProfileFor(host, rec), rec?.env);
    host.setState(name, StateRunning, HealthUnknown, 0, "");
    const healthEnv = await resolveAdoptedHealthEnv(host, name, svc, assigned);
    host.orchestrator.health.startHealth(name, svc, 0, assigned, workDir, healthEnv, gen);
    host.persistState();
    host.log(name, "INFO", `claimed running ${runtime} container ${handle.container?.id ?? ""}`);
    return true;
  }
  const occupied = await occupiedFixedPorts(svc);
  if (!occupied) {
    return false;
  }
  const first = Object.values(occupied)[0];
  const holder = first === undefined ? undefined : await findPortHolder(first);
  const pid = holder?.pid ?? 0;
  if (pid <= 0 || pid === process.pid) {
    return false;
  }
  const persistedRec = readPersistedState(host.cfg.repoRoot)?.processes.find((rec) => rec.name === name && rec.pid === pid);
  if (!persistedRec) {
    // No prior record ties this pid to this service. Matching on
    // command + cwd alone isn't enough to safely adopt — a same-command
    // process started independently of devctl would satisfy that too —
    // so without a persisted start-time to corroborate identity, treat
    // the port as unavailable rather than adopting.
    host.log(name, "WARN", `port ${first} is held by pid ${pid} with no persisted record for ${name}; not adopting`);
    return false;
  }
  if (!(await persistedHolderMatches(host, svc, persistedRec.startTime, pid))) {
    host.log(name, "WARN", `port ${first} is in use by an unrelated process (pid ${pid}); not adopting`);
    return false;
  }
  host.ports.set(name, occupied);
  // Use the persisted start time, not "now" — this process has been
  // running since persistedRec.startTime; reporting "now" would both
  // show a bogus near-zero uptime and, once this adoption is itself
  // persisted, poison the record a future adoption verifies identity
  // against.
  const gen = attachProcess(host, name, pid, [...svc.command.args], host.serviceWorkDir(svc), new Date(persistedRec.startTime)) ?? host.orchestrator.health.bumpGeneration(name);
  rememberLaunchContext(host, name, persistedProfileFor(host, persistedRec), persistedRec.env);
  host.setState(name, StateRunning, HealthUnknown, pid, "");
  host.log(name, "INFO", `already listening on ${Object.values(occupied).join(", ")}; not starting again`);
  const workDir = host.serviceWorkDir(svc);
  const healthEnv = await resolveAdoptedHealthEnv(host, name, svc, occupied);
  host.orchestrator.health.startHealth(name, svc, pid, occupied, workDir, healthEnv, gen);
  return true;
}

export async function recoverSession(host: RecoverHost): Promise<void> {
  const persisted = readPersistedState(host.cfg.repoRoot);
  if (!persisted) {
    return;
  }
  restorePersistedLaunchContext(host, persisted.profile);
  restorePersistedServiceEnvironments(host, persisted.service_environments ?? {});
  if (persisted.config_overlay) {
    host.configOverlay = persisted.config_overlay;
  }
  const adopted: string[] = [];
  for (const [name, svc] of Object.entries(host.cfg.services)) {
    if (!svc.container) continue;
    const rec = persisted.processes.find((item) => item.name === name);
    const gen = host.orchestrator.health.bumpGeneration(name);
    const runtime = svc.container.runtime === "podman" ? "podman" : "docker";
    const handle = await host.procs.adoptContainer({
      name,
      runtime,
      containerName: `devctl-${repoID(host.cfg.repoRoot)}-${name.replace(/[^a-zA-Z0-9_.-]/g, "-")}`,
      workDir: host.serviceWorkDir(svc),
      onLine: (stream, line) => host.logs.append({ timestamp: host.clock.isoNow(), service: name, source: stream, stream, level: "", message: line, pid: 0 }),
      onExit: (code, err) => host.orchestrator.health.onExit(name, gen, code, err),
    });
    if (!handle) continue;
    const assigned = rec?.ports ?? Object.fromEntries(svc.ports.filter((port) => !port.auto).map((port) => [port.name, port.value]));
    host.ports.set(name, assigned);
    host.processMeta.set(name, { command: [...svc.command.args], cwd: host.serviceWorkDir(svc), startTime: rec?.startTime ? new Date(rec.startTime) : handle.startTime });
    rememberLaunchContext(host, name, persistedProfileFor(host, rec), rec?.env);
    host.setState(name, StateRunning, HealthUnknown, 0, "");
    const healthEnv = await resolveAdoptedHealthEnv(host, name, svc, assigned);
    host.orchestrator.health.startHealth(name, svc, 0, assigned, host.serviceWorkDir(svc), healthEnv, gen);
    host.log(name, "INFO", `adopted ${runtime} container ${handle.container?.id ?? ""}`);
    adopted.push(name);
  }
  for (const rec of persisted.processes) {
    if (!host.cfg.services[rec.name] || host.cfg.services[rec.name]?.container || rec.pid <= 0 || rec.pid === process.pid || !host.processAliveFn(rec.pid)) {
      continue;
    }
    const observed = await host.inspectProcessFn(rec.pid);
    const identityOk = adoptedIdentity(rec, observed);
    if (!identityOk) {
      const portOk =
        Object.values(rec.ports).length > 0 &&
        (await occupiedFixedPorts({
          ports: Object.entries(rec.ports).map(([pname, value]) => ({ name: pname, value, auto: false })),
        })) !== undefined;
      if (portOk) {
        host.log(rec.name, "WARN", `pid ${rec.pid} does not match stored command; leftover listener not adopted`);
      } else {
        host.log(rec.name, "WARN", `pid ${rec.pid} is a different process; not adopting`);
      }
      continue;
    }
    const gen = attachProcess(host, rec.name, rec.pid, rec.command, rec.cwd, new Date(rec.startTime || host.clock.unixMs())) ?? host.orchestrator.health.bumpGeneration(rec.name);
    if (Object.keys(rec.ports).length > 0) {
      host.ports.set(rec.name, rec.ports);
    }
    rememberLaunchContext(host, rec.name, persistedProfileFor(host, rec), rec.env);
    host.setState(rec.name, StateRunning, HealthUnknown, rec.pid, "");
    const svc = host.cfg.services[rec.name];
    if (svc) {
      const workDir = rec.cwd || host.serviceWorkDir(svc);
    const healthEnv = await resolveAdoptedHealthEnv(host, rec.name, svc, rec.ports);
      host.orchestrator.health.startHealth(rec.name, svc, rec.pid, rec.ports, workDir, healthEnv, gen);
    }
    host.log(rec.name, "INFO", "adopted leftover process; stdout/stderr from before adopt are not captured");
    adopted.push(rec.name);
  }
  if (adopted.length > 0) {
    host.bus.publish(newEvent(SessionRecovered, "", { services: adopted, session_id: persisted.session_id }));
    host.log("devctl", "INFO", `recovered session processes: ${adopted.join(", ")}`);
  }
}

function restorePersistedLaunchContext(host: RecoverHost, persistedProfile: string): void {
  host.profile = persistedProfile || host.profile;
  host.profileEnv = profileEnvironment(host.cfg, host.profile);
}

function restorePersistedServiceEnvironments(host: RecoverHost, selected: Record<string, string>): void {
  for (const [name, envName] of Object.entries(selected)) {
    const svc = host.cfg.services[name];
    if (svc && serviceHasNamedEnvironments(svc)) {
      const resolved = resolveEnvironmentName(svc, envName);
      if (resolved !== "") {
        host.serviceEnv.set(name, resolved);
      }
    }
  }
}

function rememberLaunchContext(host: RecoverHost, name: string, profileName: string, envName?: string): void {
  host.serviceProfile.set(name, profileName);
  host.serviceProfileEnv.set(name, profileEnvironment(host.cfg, profileName));
  if (envName) {
    host.serviceStartedEnv.set(name, envName);
  }
}

function persistedProfileFor(host: RecoverHost, rec?: { profile?: string }): string {
  return rec?.profile ?? host.profile;
}

async function persistedHolderMatches(host: RecoverHost, svc: ServiceConfig, startTime: string, pid: number): Promise<boolean> {
  if (!host.processAliveFn(pid)) {
    return false;
  }
  const observed = await host.inspectProcessFn(pid);
  if (observed === undefined || observed.command === "") {
    // The listen pid is the one we persisted. Inspect is best-effort —
    // Windows PowerShell often times out in CI, and ps and /proc stall after a
    // WSL resume — and refusing here would turn our own leftover process
    // into a port conflict.
    return true;
  }
  // Skip cwd: Windows inspect reports the image directory, not the process
  // working directory. Pid already matched the persisted record.
  return sameAdoptedProcess(
    { args: [...svc.command.args], workDir: "", startTime: new Date(startTime) },
    observed,
  );
}

function adoptedIdentity(
  rec: { command: string[]; cwd: string; startTime: string },
  observed: ProcessIdentity | undefined,
): boolean {
  // Inspect is best-effort. After a WSL or dev-container resume, ps and
  // /proc often time out; the pid is the one we stored and it is still alive.
  if (observed === undefined || observed.command === "") {
    return true;
  }
  return sameAdoptedProcess(
    { args: rec.command, workDir: rec.cwd, startTime: rec.startTime ? new Date(rec.startTime) : undefined },
    observed,
  );
}
