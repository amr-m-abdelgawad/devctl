import { dependencyCondition, dependencyName, type DevctlConfig } from "../../../domain/config/types.ts";
import { effectiveStartupDependencies } from "../../../domain/http/recipes.ts";
import { startupPlan } from "../../../domain/service/services.ts";

// A directed edge from a dependency to the service that needs it. `condition`
// is the gate the dependent waits on ("service_started" | "service_healthy").
export type TopologyEdge = { from: string; to: string; condition: string };

export type TopologyModel = {
  // Dependency waves, left to right: column 0 has no (in-set) dependencies, and
  // every service appears one column right of its latest dependency. This is the
  // real startup layering (startupPlan().waves), so it matches launch order.
  columns: string[][];
  edges: TopologyEdge[];
  // A dependency cycle makes wave layering impossible; the graph is still shown
  // as a single column so the screen never crashes on a bad config.
  cyclic: boolean;
};

export type TopologyLink = { name: string; condition: string };

// Builds the dependency graph for every configured service. Edges use the same
// effectiveStartupDependencies() the supervisor orders by, so implicit env-derived
// dependencies show up alongside explicit `depends_on`.
export function buildTopology(cfg: DevctlConfig, profile: string): TopologyModel {
  const names = Object.keys(cfg.services);
  const profileEnv = profile !== "" ? (cfg.profiles[profile]?.environment ?? {}) : {};
  const edges: TopologyEdge[] = [];
  for (const name of names) {
    for (const dep of effectiveStartupDependencies(cfg, name, profileEnv)) {
      const from = dependencyName(dep);
      // Only draw edges between known services; a reference to a missing
      // service is a config problem surfaced elsewhere (doctor), not here.
      if (cfg.services[from]) {
        edges.push({ from, to: name, condition: dependencyCondition(dep) });
      }
    }
  }
  try {
    return { columns: startupPlan(cfg, names, profile).waves, edges, cyclic: false };
  } catch {
    return { columns: names.length > 0 ? [names.slice().sort()] : [], edges, cyclic: true };
  }
}

// Services the given service depends on (its upstream), with the gate condition.
export function upstreamOf(edges: TopologyEdge[], name: string): TopologyLink[] {
  return edges
    .filter((edge) => edge.to === name)
    .map((edge) => ({ name: edge.from, condition: edge.condition }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Services that depend on the given service (its downstream / blast radius).
export function downstreamOf(edges: TopologyEdge[], name: string): TopologyLink[] {
  return edges
    .filter((edge) => edge.from === name)
    .map((edge) => ({ name: edge.to, condition: edge.condition }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
