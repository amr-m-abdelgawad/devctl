import { emptyEnv, type DevctlConfig, type EnvConfig, type ServiceConfig } from "../config/types.ts";

/** Overlay a named environment onto the service's base `environment`. */
export function overlayEnv(base: EnvConfig, overlay: EnvConfig): EnvConfig {
  const merged: EnvConfig = {
    vars: { ...base.vars, ...overlay.vars },
    defaults: { ...base.defaults, ...overlay.defaults },
    required: uniqueKeys([...base.required, ...overlay.required]),
  };
  const terraform = overlay.terraform && (overlay.terraform.path !== "" || overlay.terraform.invalid)
    ? overlay.terraform
    : base.terraform;
  if (terraform) merged.terraform = terraform;
  const helm = overlay.helm && (overlay.helm.path !== "" || overlay.helm.invalid)
    ? overlay.helm
    : base.helm;
  if (helm) merged.helm = helm;
  return merged;
}

export function namedEnvironmentNames(svc: ServiceConfig): string[] {
  return Object.keys(svc.environments ?? {}).sort();
}

export function serviceHasNamedEnvironments(svc: ServiceConfig): boolean {
  return namedEnvironmentNames(svc).length > 0;
}

/** YAML `default_environment`, else the first named environment alphabetically, else "". */
export function defaultEnvironmentName(svc: ServiceConfig): string {
  if (svc.default_environment !== "" && svc.environments?.[svc.default_environment]) {
    return svc.default_environment;
  }
  return namedEnvironmentNames(svc)[0] ?? "";
}

/**
 * Pick the environment that will be applied on the next start/exec.
 * Unknown or empty selections fall back to the service default.
 */
export function resolveEnvironmentName(svc: ServiceConfig, selected?: string): string {
  const names = namedEnvironmentNames(svc);
  if (names.length === 0) {
    return "";
  }
  if (selected && names.includes(selected)) {
    return selected;
  }
  return defaultEnvironmentName(svc);
}

function namedEnvironment(svc: ServiceConfig, name: string): EnvConfig | undefined {
  if (name === "") {
    return undefined;
  }
  return svc.environments?.[name];
}

/** Base `environment` plus the selected named overlay (if any). */
export function effectiveServiceEnv(svc: ServiceConfig, selected?: string): EnvConfig {
  const base = svc.environment ?? { vars: {}, required: [], defaults: {} };
  const name = resolveEnvironmentName(svc, selected);
  const overlay = namedEnvironment(svc, name);
  if (!overlay) {
    return cloneEnv(base);
  }
  return overlayEnv(base, overlay);
}

/** Base env plus every named overlay — used for config-time ref / recipe planning. */
export function allServiceEnvConfigs(svc: ServiceConfig): EnvConfig[] {
  const base = svc.environment ?? { vars: {}, required: [], defaults: {} };
  const out = [cloneEnv(base)];
  for (const name of namedEnvironmentNames(svc)) {
    const overlay = svc.environments?.[name];
    if (overlay) {
      out.push(overlayEnv(base, overlay));
    }
  }
  return out;
}

function cloneEnv(env: EnvConfig): EnvConfig {
  const cloned: EnvConfig = {
    vars: { ...env.vars },
    defaults: { ...env.defaults },
    required: [...env.required],
  };
  if (env.terraform) cloned.terraform = { ...env.terraform };
  if (env.helm) cloned.helm = { ...env.helm };
  return cloned;
}

function uniqueKeys(values: string[]): string[] {
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  for (const value of values) {
    if (value !== "" && !seen[value]) {
      seen[value] = true;
      out.push(value);
    }
  }
  return out;
}

/** Overlay name bound on `profiles.<profile>.environments.<service>`, or "". */
export function profileBoundOverlay(cfg: DevctlConfig, profile: string, service: string): string {
  if (profile === "") {
    return "";
  }
  return cfg.profiles[profile]?.environments[service] ?? "";
}

export function profileServiceEnvConfig(cfg: DevctlConfig, profile: string, service: string): EnvConfig {
  if (profile === "") {
    return emptyEnv();
  }
  return cfg.profiles[profile]?.service_environment[service] ?? emptyEnv();
}

/**
 * Env that a profile start will actually apply: named overlay bind (else the
 * session/default overlay) plus `service_environment` on top.
 */
export function effectiveProfileLaunchEnv(
  cfg: DevctlConfig,
  service: string,
  profile: string,
  sessionOverlay = "",
): EnvConfig {
  const svc = cfg.services[service];
  if (!svc) {
    return emptyEnv();
  }
  const bound = profileBoundOverlay(cfg, profile, service);
  const env = effectiveServiceEnv(svc, bound !== "" ? bound : sessionOverlay);
  const extra = profileServiceEnvConfig(cfg, profile, service);
  if (Object.keys(extra.vars).length === 0 && Object.keys(extra.defaults).length === 0 && extra.required.length === 0) {
    return env;
  }
  return overlayEnv(env, extra);
}
