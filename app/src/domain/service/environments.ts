import { type EnvConfig, type ServiceConfig } from "../config/types.ts";

/** Overlay a named environment onto the service's base `environment`. */
export function overlayEnv(base: EnvConfig, overlay: EnvConfig): EnvConfig {
  return {
    vars: { ...base.vars, ...overlay.vars },
    defaults: { ...base.defaults, ...overlay.defaults },
    required: uniqueKeys([...base.required, ...overlay.required]),
  };
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
  return {
    vars: { ...env.vars },
    defaults: { ...env.defaults },
    required: [...env.required],
  };
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
