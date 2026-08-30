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
  };
}

export type PlanStep = {
  name: string;
  wave: number;
  dependencies: string[];
};

export type Plan = {
  profile: string;
  steps: PlanStep[];
  waves: string[][];
};

export function startupPlan(cfg: DevctlConfig, selected: string[], profile: string): Plan {
  const needed: Record<string, boolean> = {};
  const visit = (name: string): void => {
    if (needed[name]) {
      return;
    }
    const svc = cfg.services[name];
    if (!svc) {
      throw newError(KindServiceNotFound, `unknown service "${name}"`);
    }
    needed[name] = true;
    for (const dep of svc.dependencies) {
      visit(dep);
    }
  };
  for (const name of selected) {
    visit(name);
  }
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
  return { profile, steps, waves };
}

export function shutdownPlan(cfg: DevctlConfig, selected: string[]): Plan {
  const start = startupPlan(cfg, selected, "");
  const waves = [...start.waves].reverse().map((wave) => [...wave].sort());
  const steps: PlanStep[] = [];
  waves.forEach((wave, i) => {
    for (const name of wave) {
      steps.push({ name, wave: i + 1, dependencies: cfg.services[name]?.dependencies ?? [] });
    }
  });
  return { steps, waves, profile: "" };
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
  return out;
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
