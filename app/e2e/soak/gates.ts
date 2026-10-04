// One switch for checks that pin a production bug the merged code still has.
// `DEVCTL_SOAK_REQUIRE=key1,key2` (or `all`) runs them; otherwise they are
// skipped and the test name says which key enables them. An enabled check
// runs its real assertion and fails while the bug is there. It never passes
// by skipping itself. Delete a key once its check passes ungated.
//
// Shared by the Docker soak suite (e2e/soak) and the findings pinned on the
// host (test/findings), so there is one knob for both.

export const GATES = {
  "stale-pipeline-stats": "finding: the log worker's pipeline stats are only refreshed by the next record, so status keeps reporting spooled bytes after output stops",
  "sigkill-boundary-loss": "finding: output a SIGKILLed daemon had read from a FIFO but not yet persisted (its in-memory pipeline and 100 ms writer batch) is lost",
  "logs-all-bounded": "finding: `devctl logs --all` answers with the whole ring in one reply, so the daemon passes 400 MB and the CLI is OOM-killed on a ring of long lines",
  "attribution-short-calls": "finding: a call that ends within a millisecond or two on a connection its caller then closes is recorded with no caller, because the /proc lookup finishes after the socket is gone",
  "attribution-fd-scan": "finding: the caller lookup reads every descriptor of each managed process in turn; with a service holding 5000 that takes 120-250 ms, so shorter calls on connections closed afterwards get no caller",
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
