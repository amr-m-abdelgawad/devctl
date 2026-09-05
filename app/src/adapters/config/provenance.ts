import { type ConfigOrigin, type DevctlConfig } from "../../domain/config/types.ts";

export type ConfigDiffEntry = ConfigOrigin & {
  path: string;
  value: unknown;
  shadowed: ConfigOrigin[];
};

export function configDiff(cfg: DevctlConfig): ConfigDiffEntry[] {
  return Object.entries(cfg.provenance)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, history]) => {
      const winner = history[history.length - 1];
      if (!winner) return [];
      return [{ path, value: valueAtPath(cfg, path), ...winner, shadowed: history.slice(0, -1) }];
    });
}

function valueAtPath(root: unknown, path: string): unknown {
  let value = root;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
