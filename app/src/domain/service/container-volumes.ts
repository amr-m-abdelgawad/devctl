import type { ContainerConfig } from "../config/types.ts";

// Parallel stacks (#117): a named volume (`pgdata:/var/lib/postgresql/data`)
// belongs to one stack, so two checkouts of a config never share a
// database. The runtime sees `devctl-<id>-pgdata`, the same prefix as the
// stack's container names. Bind mounts (`./data:/data`, `/abs:/x`), anonymous
// volumes (`/data`) and names listed in `shared_volumes` pass through as
// written.

/** A volume to fill before its first use, from `from` (a volume name as the runtime knows it). */
export type VolumeSeed = {
  volume: string;
  from: string;
  // `seed_from` names a volume that must exist; the implicit seed from the
  // unprefixed volume a config used before (#117) is skipped when absent.
  required: boolean;
};

// Docker and Podman volume names: at least two characters, which also keeps
// a Windows drive letter (`C:\data:/data`) from reading as one.
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/;

export function isVolumeName(name: string): boolean {
  return VOLUME_NAME.test(name);
}

/** The named volume a `--volume` spec mounts, or undefined for a bind mount or an anonymous volume. */
export function namedVolume(spec: string): string | undefined {
  const colon = spec.indexOf(":");
  if (colon < 0) {
    return undefined;
  }
  const source = spec.slice(0, colon);
  return isVolumeName(source) ? source : undefined;
}

export function scopedVolumeName(prefix: string, name: string): string {
  return `${prefix}${name}`;
}

/** The container's volumes as this stack mounts them, and the seeds to run before first use. */
export function scopeVolumes(container: Pick<ContainerConfig, "volumes" | "seed_from" | "shared_volumes">, prefix: string): { volumes: string[]; seeds: VolumeSeed[] } {
  const shared = new Set(container.shared_volumes);
  const volumes: string[] = [];
  const seeds: VolumeSeed[] = [];
  for (const spec of container.volumes) {
    const name = namedVolume(spec);
    if (name === undefined || shared.has(name)) {
      volumes.push(spec);
      continue;
    }
    const scoped = scopedVolumeName(prefix, name);
    volumes.push(`${scoped}${spec.slice(name.length)}`);
    const from = container.seed_from[name];
    seeds.push(from === undefined ? { volume: scoped, from: name, required: false } : { volume: scoped, from, required: true });
  }
  return { volumes, seeds };
}

/** `seed_from` and `shared_volumes` may only name the container's own named volumes. */
export function volumeConfigIssues(prefix: string, container: Pick<ContainerConfig, "volumes" | "seed_from" | "shared_volumes">): string[] {
  const issues: string[] = [];
  const named = new Set(container.volumes.map(namedVolume).filter((name): name is string => name !== undefined));
  const shared = new Set(container.shared_volumes);
  for (const name of container.shared_volumes) {
    if (!named.has(name)) {
      issues.push(`${prefix}.container.shared_volumes: "${name}" is not a named volume in container.volumes`);
    }
  }
  for (const [name, from] of Object.entries(container.seed_from)) {
    if (!named.has(name)) {
      issues.push(`${prefix}.container.seed_from.${name}: not a named volume in container.volumes`);
    } else if (shared.has(name)) {
      issues.push(`${prefix}.container.seed_from.${name}: a shared volume is never seeded; remove it from one of seed_from and shared_volumes`);
    }
    if (!isVolumeName(from)) {
      issues.push(`${prefix}.container.seed_from.${name}: "${from}" is not a volume name`);
    }
  }
  return issues;
}
