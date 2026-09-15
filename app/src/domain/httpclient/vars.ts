import type { HttpClientVar } from "./request.ts";

export type VarLayers = {
  runtime?: Record<string, string>;
  request?: readonly HttpClientVar[];
  folders?: readonly (readonly HttpClientVar[])[];
  selected?: Record<string, string>;
  collection?: readonly HttpClientVar[];
  processEnv?: Record<string, string | undefined>;
};

function enabledVars(vars: readonly HttpClientVar[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars) {
    return out;
  }
  for (const item of vars) {
    if (item.enabled && item.name !== "") {
      out[item.name] = item.value;
    }
  }
  return out;
}

function definedEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) {
    return out;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Merge variable layers. Highest → lowest:
 * runtime/prompt → request vars → folder vars (leaf over parent) →
 * selected var-source (Bruno env or a devctl profile) → collection vars → process env.
 */
export function mergeVars(layers: VarLayers): Record<string, string> {
  const out: Record<string, string> = {
    ...definedEnv(layers.processEnv),
    ...enabledVars(layers.collection),
    ...(layers.selected ?? {}),
  };
  const folders = layers.folders ?? [];
  for (const folder of folders) {
    Object.assign(out, enabledVars(folder));
  }
  Object.assign(out, enabledVars(layers.request));
  Object.assign(out, layers.runtime ?? {});
  return out;
}
