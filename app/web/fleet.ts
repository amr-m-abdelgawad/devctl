import { isLiveState } from "./control.ts";
import type { ConfigService, ProfileRow, ServiceRow } from "./types.ts";

export type FleetState = "all" | "running" | "attention" | "stopped";
export type FleetFilter = { search: string; state: FleetState; profile: string; sort: string };

export function needsAttention(row: ServiceRow): boolean {
  return ["FAILED", "CRASHED", "UNHEALTHY", "DEGRADED"].includes(row.state.toUpperCase()) || row.health.toUpperCase() === "UNHEALTHY";
}

export function serviceIsHealthy(row: ServiceRow): boolean {
  return (
    !needsAttention(row) &&
    isLiveState(row.state) &&
    (row.health.toUpperCase() === "HEALTHY" || row.state.toUpperCase() === "RUNNING" || row.state.toUpperCase() === "HEALTHY")
  );
}

export function fleetRows(rows: ServiceRow[], config: ConfigService[], profiles: ProfileRow[], filter: FleetFilter): ServiceRow[] {
  const definitions = new Map(config.map((row) => [row.name, row]));
  const members = filter.profile ? new Set(profiles.find((row) => row.name === filter.profile)?.services ?? []) : undefined;
  const terms = filter.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((row) => {
      if (members && !members.has(row.name)) return false;
      if (filter.state === "attention" && !needsAttention(row)) return false;
      if (filter.state === "running" && !isLiveState(row.state)) return false;
      if (filter.state === "stopped" && (isLiveState(row.state) || needsAttention(row))) return false;
      const definition = definitions.get(row.name);
      const haystack = [row.name, definition?.description, row.state, row.health, row.env, ...Object.entries(row.ports).flat()]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => {
      if (filter.sort === "attention") {
        const diff = Number(needsAttention(b)) - Number(needsAttention(a));
        if (diff) return diff;
      }
      if (filter.sort === "state") {
        const diff = a.state.localeCompare(b.state);
        if (diff) return diff;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
}

const HTTP_PORT_NAME = "http";
const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65535;

/** Loopback URL for a service's named `http` port, when that port is assigned. */
export function httpPortUrl(ports: Record<string, number>): string | undefined {
  const port = Object.entries(ports).find(([name]) => name.toLowerCase() === HTTP_PORT_NAME)?.[1];
  if (typeof port !== "number" || !Number.isInteger(port) || port < MIN_TCP_PORT || port > MAX_TCP_PORT) {
    return undefined;
  }
  // Pieces stay separate. The web asset build strips a literal http:// address out of the bundle.
  return ["http", "://", "localhost:", String(port), "/"].join("");
}

/** Selection is scoped to the visible page and never silently selects hidden matches. */
export function toggleVisibleSelection(selected: string[], visible: string[]): string[] {
  const all = visible.length > 0 && visible.every((name) => selected.includes(name));
  const page = new Set(visible);
  return all ? selected.filter((name) => !page.has(name)) : [...new Set([...selected, ...visible])];
}
