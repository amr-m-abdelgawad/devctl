import { setTimeout as delay } from "node:timers/promises";
import type { Controller } from "../../application/client-runtime.ts";
import type { DevctlConfig } from "../../domain/config/types.ts";
import { readinessMessage, stackReadiness } from "../../domain/harness.ts";
import type { Plan } from "../../domain/service/services.ts";
import { hintError, KindHealthCheck, KindProcessStart } from "../../shared/errors.ts";

// `devctl start --wait` and `devctl test` (#118).

export const DEFAULT_WAIT_TIMEOUT = "5m";
const POLL_MS = 250;

/** The services a start asked for: what `--wait` waits on. */
export function plannedServices(plan: Plan): string[] {
  return plan.waves.flat();
}

/**
 * Blocks until every service in `names` is ready (see stackReadiness).
 * Throws a process-start error (exit 5) when one fails or is blocked, and a
 * health error (exit 6) naming the stragglers when `timeoutMs` runs out.
 */
export async function waitForStack(ctrl: Pick<Controller, "status">, cfg: Pick<DevctlConfig, "services">, plan: Plan, timeoutMs: number): Promise<void> {
  const blocked = plan.blockers ?? [];
  if (blocked.length > 0) {
    throw hintError(KindProcessStart, `services blocked: ${blocked.map((b) => `${b.name} (${b.message})`).join(", ")}`, "fix the blocker, then start again");
  }
  const names = plannedServices(plan);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const readiness = stackReadiness(cfg, names, await ctrl.status());
    if (readiness.ready) {
      return;
    }
    if (readiness.failed.length > 0) {
      throw hintError(KindProcessStart, readinessMessage(readiness), `devctl logs ${readiness.failed.map((svc) => svc.name).join(" ")}`);
    }
    if (Date.now() >= deadline) {
      throw hintError(KindHealthCheck, readinessMessage(readiness, timeoutMs), `devctl logs ${readiness.waiting.map((svc) => svc.name).join(" ")}`);
    }
    await delay(POLL_MS);
  }
}

