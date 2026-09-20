import type { ConfigService } from "./types.ts";

function depName(dep: ConfigService["dependencies"][number]): string {
  return typeof dep === "string" ? dep : dep.service;
}

function dependsOnSet(svc: ConfigService, selected: ReadonlySet<string>, extra: ReadonlySet<string>): boolean {
  return svc.dependencies.some((dep) => {
    const name = depName(dep);
    return selected.has(name) || extra.has(name);
  });
}

function addDirectDependents(
  config: ConfigService[],
  selected: ReadonlySet<string>,
  extra: Set<string>,
): boolean {
  let grew = false;
  for (const svc of config) {
    if (!selected.has(svc.name) && !extra.has(svc.name) && dependsOnSet(svc, selected, extra)) {
      extra.add(svc.name);
      grew = true;
    }
  }
  return grew;
}

/** Services that transitively depend on `names`, excluding `names` themselves. */
export function restartDependents(config: ConfigService[], names: readonly string[]): string[] {
  if (names.length === 0) {
    return [];
  }
  const selected = new Set(names);
  const extra = new Set<string>();
  let grew = true;
  while (grew) {
    grew = addDirectDependents(config, selected, extra);
  }
  return [...extra].sort((a, b) => a.localeCompare(b));
}
