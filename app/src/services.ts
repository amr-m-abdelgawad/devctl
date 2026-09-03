import { type DevctlConfig } from "./config/index.ts";
import { KindConfiguration, KindDependency, KindServiceNotFound, newError } from "./errors.ts";

export const StateUnknown = "UNKNOWN";
export const StateStarting = "STARTING";
export const StateRunning = "RUNNING";
export const StateHealthy = "HEALTHY";
export const StateUnhealthy = "UNHEALTHY";
export const StateStopping = "STOPPING";
export const StateStopped = "STOPPED";
export const StateFailed = "FAILED";
export const StateRestarting = "RESTARTING";

export type ServiceState =
  | typeof StateUnknown
  | typeof StateStarting
  | typeof StateRunning
  | typeof StateHealthy
  | typeof StateUnhealthy
  | typeof StateStopping
  | typeof StateStopped
  | typeof StateFailed
  | typeof StateRestarting;

export const HealthUnknown = "UNKNOWN";
export const HealthHealthy = "HEALTHY";
export const HealthUnhealthy = "UNHEALTHY";

export type ServiceHealth = typeof HealthUnknown | typeof HealthHealthy | typeof HealthUnhealthy;

export type Runtime = {
  name: string;
  state: ServiceState;
  health: ServiceHealth;
  pid: number;
  ports: Record<string, number>;
  restarts: number;
  last_error: string;
  identity: string;
  startTime?: string;
  cpuPercent?: number;
  memoryKB?: number;
  // Non-secret launch context: the profile in effect (empty if never
  // explicitly started under one) and whether its environment's "process"
  // layer came from a real client or the daemon's own fallback — never the
  // resolved environment values themselves, which may hold secrets.
  profile: string;
  env_source: "client" | "daemon";
  // Set when this service was removed from configuration (by a reload)
  // while still running. Its dependency graph is gone along with its
  // config entry, so it can only be stopped directly, never cascaded to or
  // restarted — devctl has nothing left to relaunch it with.
  orphaned: boolean;
};

export function displayState(rt: Runtime): string {
  if (rt.state === StateRunning && rt.health === HealthHealthy) {
    return StateHealthy;
  }
  if (rt.state === StateRunning && rt.health === HealthUnhealthy) {
    return StateUnhealthy;
  }
  return rt.state;
}

export function emptyRuntime(name: string): Runtime {
  return {
    name,
    state: StateStopped,
    health: HealthUnknown,
    pid: 0,
    ports: {},
    restarts: 0,
    last_error: "",
    identity: "",
    startTime: undefined,
    cpuPercent: undefined,
    memoryKB: undefined,
    profile: "",
    env_source: "daemon",
    orphaned: false,
  };
}

export type PlanStep = {
  name: string;
  wave: number;
  dependencies: string[];
};

export type PlanBlocker = {
  name: string;
  message: string;
};

export type Plan = {
  profile: string;
  steps: PlanStep[];
  waves: string[][];
  blockers?: PlanBlocker[];
};

// Topologically sorts an already-determined set of services into
// dependency-respecting waves (a service's dependencies, restricted to this
// same set, all come out in an earlier wave). Shared by startupPlan (whose
// "needed" set is a dependency closure) and shutdownPlan/shutdownPlanExact
// (whose "needed" set is a dependents closure, or the exact selection).
function wavesForSet(cfg: DevctlConfig, needed: Record<string, boolean>): string[][] {
  const indegree: Record<string, number> = {};
  const edges: Record<string, string[]> = {};
  for (const name of Object.keys(needed)) {
    indegree[name] = 0;
  }
  for (const name of Object.keys(needed)) {
    const deps = cfg.services[name]?.dependencies ?? [];
    for (const dep of deps) {
      if (!needed[dep]) {
        continue;
      }
      edges[dep] = [...(edges[dep] ?? []), name];
      indegree[name] = (indegree[name] ?? 0) + 1;
    }
  }
  const waves: string[][] = [];
  let remaining = Object.keys(needed).length;
  const seen: Record<string, boolean> = {};
  while (remaining > 0) {
    const wave = Object.entries(indegree)
      .filter(([name, deg]) => deg === 0 && !seen[name])
      .map(([name]) => name)
      .sort();
    if (wave.length === 0) {
      throw newError(KindDependency, "dependency cycle detected while planning startup");
    }
    waves.push(wave);
    for (const name of wave) {
      seen[name] = true;
      remaining -= 1;
      for (const next of edges[name] ?? []) {
        indegree[next] = (indegree[next] ?? 0) - 1;
      }
    }
  }
  return waves;
}

function requireKnown(cfg: DevctlConfig, name: string): void {
  if (!cfg.services[name]) {
    throw newError(KindServiceNotFound, `unknown service "${name}"`);
  }
}

export function startupPlan(cfg: DevctlConfig, selected: string[], profile: string): Plan {
  const needed: Record<string, boolean> = {};
  const visit = (name: string): void => {
    if (needed[name]) {
      return;
    }
    requireKnown(cfg, name);
    needed[name] = true;
    for (const dep of cfg.services[name]?.dependencies ?? []) {
      visit(dep);
    }
  };
  for (const name of selected) {
    visit(name);
  }
  const waves = wavesForSet(cfg, needed);
  const steps: PlanStep[] = [];
  waves.forEach((wave, i) => {
    for (const name of wave) {
      steps.push({
        name,
        wave: i + 1,
        dependencies: [...(cfg.services[name]?.dependencies ?? [])],
      });
    }
  });
  return { profile, steps, waves, blockers: [] };
}

// Every service that depends on `selected`, directly or transitively,
// including `selected` itself — the reverse of startupPlan's dependency
// closure. Exported so a cascading restart can start back up exactly what
// shutdownPlan stopped.
export function dependentsClosure(cfg: DevctlConfig, selected: string[]): string[] {
  const dependents: Record<string, string[]> = {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    for (const dep of svc.dependencies) {
      dependents[dep] = [...(dependents[dep] ?? []), name];
    }
  }
  const needed: Record<string, boolean> = {};
  const visit = (name: string): void => {
    if (needed[name]) {
      return;
    }
    requireKnown(cfg, name);
    needed[name] = true;
    for (const dependent of dependents[name] ?? []) {
      visit(dependent);
    }
  };
  for (const name of selected) {
    visit(name);
  }
  return Object.keys(needed);
}

function reversedPlanForSet(cfg: DevctlConfig, needed: Record<string, boolean>): Plan {
  const waves = [...wavesForSet(cfg, needed)].reverse().map((wave) => [...wave].sort());
  const steps: PlanStep[] = [];
  waves.forEach((wave, i) => {
    for (const name of wave) {
      steps.push({ name, wave: i + 1, dependencies: cfg.services[name]?.dependencies ?? [] });
    }
  });
  return { steps, waves, profile: "", blockers: [] };
}

// stop x must also stop everything that depends on x, directly or
// transitively — never x's own dependencies, which other running services
// may still need. This is the public semantics for `devctl stop` and plain
// `devctl down`; it is the mirror image of startupPlan's dependency
// closure, walking the reverse edge (who depends on me) instead.
export function shutdownPlan(cfg: DevctlConfig, selected: string[]): Plan {
  const needed = Object.fromEntries(dependentsClosure(cfg, selected).map((name) => [name, true]));
  return reversedPlanForSet(cfg, needed);
}

// Stops exactly the named services, in dependency-respecting order, with no
// dependents expansion — what a plain `restart x` (no --cascade) uses so it
// never touches anything downstream of x.
export function shutdownPlanExact(cfg: DevctlConfig, selected: string[]): Plan {
  const needed: Record<string, boolean> = {};
  for (const name of selected) {
    requireKnown(cfg, name);
    needed[name] = true;
  }
  return reversedPlanForSet(cfg, needed);
}

export function formatPlan(plan: Plan): string {
  let out = "";
  if (plan.profile !== "") {
    out += `Profile: ${plan.profile}\n\n`;
  }
  out += "Plan:\n\n";
  let n = 1;
  for (const wave of plan.waves) {
    for (const name of wave) {
      out += `${n}. ${name}\n`;
      n += 1;
    }
  }
  if ((plan.blockers ?? []).length > 0) {
    out += "\nBlocked:\n";
    for (const blocker of plan.blockers ?? []) {
      out += `- ${blocker.name}: ${blocker.message}\n`;
    }
  }
  return out;
}

// Advice for the settings a running daemon reads once at boot (log
// capacity/persistence, auth refresh threshold, plugin paths) and therefore
// cannot pick up from a reload. It has to name `devctl down`: `stop`
// deliberately leaves the daemon running (it only stops services), so the
// stop-then-start pair this used to advise would restart the services and
// leave the very daemon holding the stale settings untouched. Shared by the
// daemon's own log line and the CLI's reload note so the two can't drift
// apart again.
export function supervisorRestartAdvice(fields: string[]): string {
  return `${fields.join(", ")} changed and only take effect after a full \`devctl down && devctl start\`, not a reload`;
}

// Empty name and empty extra still means every service. Start paths must use resolveStartRequest.
export function resolveProfile(
  cfg: DevctlConfig,
  name: string,
  extra: string[],
): { services: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  if (name !== "") {
    const profile = cfg.profiles[name];
    if (!profile) {
      throw newError("configuration", `unknown profile "${name}"`);
    }
    Object.assign(env, profile.environment);
  }
  if (extra.length > 0) {
    return { services: uniqueServices(cfg, extra), env };
  }
  if (name === "") {
    return { services: Object.keys(cfg.services), env };
  }
  return { services: uniqueServices(cfg, cfg.profiles[name]?.services ?? []), env };
}

export function firstProfileName(cfg: DevctlConfig): string {
  const names = Object.keys(cfg.profiles).sort();
  return names[0] ?? "";
}

export function resolveStartRequest(
  cfg: DevctlConfig,
  opts: { services?: string[]; profile?: string; activeProfile?: string },
): { services: string[]; profile: string; env: Record<string, string> } {
  const extra = opts.services ?? [];
  let profile = opts.profile ?? "";
  if (extra.length === 0 && profile === "") {
    profile = opts.activeProfile || firstProfileName(cfg);
    if (profile === "") {
      throw newError(KindConfiguration, "no profile or services given; pass service names or add a profile");
    }
  }
  const resolved = resolveProfile(cfg, profile, extra);
  return { services: resolved.services, env: resolved.env, profile };
}

function uniqueServices(cfg: DevctlConfig, names: string[]): string[] {
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  for (const svc of names) {
    if (seen[svc]) {
      continue;
    }
    if (!cfg.services[svc]) {
      throw newError("service_not_found", `unknown service "${svc}"`);
    }
    seen[svc] = true;
    out.push(svc);
  }
  return out;
}
