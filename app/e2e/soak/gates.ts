// One switch for checks that need another track's work, or that pin a
// production bug this branch still has. `DEVCTL_SOAK_REQUIRE=key1,key2` (or
// `all`) runs them; otherwise they are skipped and the test name says which
// key enables them. An enabled check runs its real assertion and fails while
// the behavior is missing. It never passes by skipping itself.
//
// Shared by the Docker soak suite (e2e/soak) and the ingest oracle
// (test/oracle), so the lead has one knob for both.

export const GATES = {
  "embedded-workers": "Track C: the compiled binary runs its log and watchdog workers instead of falling back in-process",
  ws8: "Track D: services keep running and their logs resume after the daemon is SIGKILLed",
  "event-time-folding": "Track A: output parsed late (a spool backlog) folds and correlates by read time, like live output",
  "proxy-hop-order": "finding: a proxy access record committed before the service line it answers leaves that line without its request id",
  "stale-pipeline-stats": "finding: the log worker's pipeline stats are only refreshed by the next record, so status keeps reporting spooled bytes after output stops",
} as const;

export type GateKey = keyof typeof GATES;

function requested(env: string | undefined): Set<string> {
  return new Set((env ?? "").split(",").map((key) => key.trim()).filter((key) => key !== ""));
}

/** True when `DEVCTL_SOAK_REQUIRE` names `key` (or `all`). */
export function gateEnabled(key: GateKey, env = process.env.DEVCTL_SOAK_REQUIRE): boolean {
  const keys = requested(env);
  return keys.has("all") || keys.has(key);
}

/** The test name, with the skip reason and the key that enables it while it is gated off. */
export function gatedName(key: GateKey, name: string, env = process.env.DEVCTL_SOAK_REQUIRE): string {
  return gateEnabled(key, env) ? `${name} [${key}]` : `${name} [gated: DEVCTL_SOAK_REQUIRE=${key} — ${GATES[key]}]`;
}
