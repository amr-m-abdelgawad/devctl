// The test/CI harness (#118): `devctl start --wait`, `devctl test` and
// `devctl bundle`. Pure pieces only: readiness, the environment a test
// command gets, durations, and redaction of what goes into a bundle.
import type { DevctlConfig } from "./config/types.ts";
import { HealthHealthy, StateFailed, StateHealthy, StateRunning } from "./service/services.ts";
import type { StatusSnapshot } from "./status.ts";
import type { LogEvent } from "./logs/types.ts";
import { REDACTED_VALUE, type Detector } from "../shared/redaction.ts";

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** `90s`, `2m`, `500ms`, `1h`, or a bare number of seconds. */
export function parseDuration(text: string): number {
  const trimmed = text.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1_000);
  }
  const match = DURATION.exec(trimmed);
  if (!match) {
    throw new Error(`invalid duration "${text}": use a number with ms, s, m or h (2m, 90s)`);
  }
  return Math.round(Number(match[1]) * (UNIT_MS[match[2] ?? "s"] ?? 1_000));
}

export type StackReadiness = {
  ready: boolean;
  // Still starting, or running but not yet healthy: waiting may help.
  waiting: { name: string; state: string }[];
  // FAILED: waiting will not help.
  failed: { name: string; error: string }[];
};

/**
 * Whether the services a start asked for are ready. A service is ready when
 * it is RUNNING and, if it has a health check, HEALTHY. A service without a
 * health check counts as ready once it is running: devctl has nothing else
 * to wait on, so give it a `health` block when "listening" matters.
 */
export function stackReadiness(cfg: Pick<DevctlConfig, "services">, names: readonly string[], snap: StatusSnapshot): StackReadiness {
  const waiting: StackReadiness["waiting"] = [];
  const failed: StackReadiness["failed"] = [];
  for (const name of names) {
    const rt = snap.services[name];
    const checked = hasHealthCheck(cfg, name);
    if (!rt) {
      waiting.push({ name, state: "UNKNOWN" });
    } else if (rt.state === StateFailed) {
      failed.push({ name, error: rt.last_error });
    } else if (!isReady(rt.state, rt.health, checked)) {
      waiting.push({ name, state: rt.state });
    }
  }
  return { ready: waiting.length === 0 && failed.length === 0, waiting, failed };
}

// The snapshot reports display states: a running service whose check passes
// is HEALTHY (UNHEALTHY when it fails), not RUNNING.
function isReady(state: string, health: string, checked: boolean): boolean {
  if (state === StateHealthy) {
    return true;
  }
  return state === StateRunning && (!checked || health === HealthHealthy);
}

function hasHealthCheck(cfg: Pick<DevctlConfig, "services">, name: string): boolean {
  const type = cfg.services[name]?.health.type ?? "";
  return type !== "" && type !== "none";
}

export function readinessMessage(readiness: StackReadiness, timeoutMs?: number): string {
  if (readiness.failed.length > 0) {
    return `services failed to start: ${readiness.failed.map((svc) => (svc.error ? `${svc.name} (${svc.error})` : svc.name)).join(", ")}`;
  }
  const names = readiness.waiting.map((svc) => `${svc.name} (${svc.state})`).join(", ");
  return timeoutMs === undefined ? `services not ready: ${names}` : `services not ready after ${formatDuration(timeoutMs)}: ${names}`;
}

export function formatDuration(ms: number): string {
  if (ms % 60_000 === 0 && ms >= 60_000) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/**
 * What a `devctl test -- <command>` gets on top of the caller's own
 * environment: where the stack is. Ports move with the stack's slot (#117),
 * so tests read them from here instead of hardcoding them.
 *
 * DEVCTL_<SERVICE>_<PORT>_PORT for every running service port, SERVICE and
 * PORT uppercased with anything but letters and digits turned into `_`;
 * DEVCTL_PROXY_URL while the proxy is up; DEVCTL_INSTANCE for the stack.
 */
export function stackEnvironment(snap: StatusSnapshot, instance: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (instance !== "") {
    env.DEVCTL_INSTANCE = instance;
  }
  if (snap.proxy?.running && snap.proxy.address) {
    env.DEVCTL_PROXY_URL = snap.proxy.address.startsWith("http") ? snap.proxy.address : `http://${snap.proxy.address}`;
  }
  for (const [name, rt] of Object.entries(snap.services)) {
    for (const [portName, port] of Object.entries(rt.ports)) {
      if (port > 0) {
        env[`DEVCTL_${envKey(name)}_${envKey(portName)}_PORT`] = String(port);
      }
    }
  }
  return env;
}

function envKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * A bundle is meant to be attached to a build or a bug report, so it is
 * always redacted, whatever `secrets.redact` says: secret-named keys are
 * masked and every string goes through the log and traffic detector.
 * Unlike log attribute redaction it keeps every item, so nothing is
 * silently cut from the evidence.
 */
export function redactJson(detector: Detector, value: unknown, keyHint = ""): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return detector.masksString(keyHint, value) ? REDACTED_VALUE : detector.redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(detector, item, keyHint));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactJson(detector, item, key);
    }
    return out;
  }
  return value;
}

const MIN_KNOWN_SECRET = 6;

/**
 * Literal values the configuration gives secret-named keys (`API_TOKEN:
 * sk-live-…` in a service's environment, say). A service that prints one
 * leaves it in its logs in a shape no pattern recognizes, so a bundle masks
 * these values wherever they appear. `${…}` templates are skipped: only what
 * the config spells out, nothing decrypted or read from secrets.env.
 */
export function configSecretValues(detector: Detector, cfg: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, key: string, depth: number): void => {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (value.length >= MIN_KNOWN_SECRET && !value.includes("${") && detector.masksString(key, value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) walk(item, childKey, depth + 1);
    }
  };
  walk(cfg, "", 0);
  // Longest first, so a secret that contains another is replaced whole.
  return [...found].sort((a, b) => b.length - a.length);
}

/** Replaces each known secret value in `text`, raw or as it appears inside a JSON string. */
export function maskKnownValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    out = out.split(value).join(REDACTED_VALUE);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) out = out.split(escaped).join(REDACTED_VALUE);
  }
  return out;
}

/** Trace ids worth including in a bundle: those of error logs and failed proxied requests, newest first. */
export function failedTraceIds(logs: readonly Pick<LogEvent, "severityText" | "traceId">[], snap: StatusSnapshot, limit: number): string[] {
  const ids: string[] = [];
  const add = (id: string | undefined): void => {
    if (id && !ids.includes(id) && ids.length < limit) ids.push(id);
  };
  for (const req of [...(snap.proxy?.recentRequests ?? [])].reverse()) {
    if (req.status >= 500 || req.status === 0) add(req.traceId);
  }
  for (const event of [...logs].reverse()) {
    const level = event.severityText.toUpperCase();
    if (level === "ERROR" || level === "FATAL") add(event.traceId);
  }
  return ids;
}
