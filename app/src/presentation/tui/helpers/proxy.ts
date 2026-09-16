import { type ProxyRequestSnapshot } from "../../../domain/status.ts";
import { percentile } from "../../../domain/telemetry/metrics.ts";
import { clipText, formatDurationMs } from "./format.ts";

export const PROXY_DURATION_MISSING = "—";

export type ProxyDurationView = {
  readonly request: string;
  readonly hop: string;
};

export function proxyDurationView(req: { durationMs: number; traceDurationMs?: number }): ProxyDurationView {
  const hop = formatDurationMs(req.durationMs);
  if (req.traceDurationMs === undefined) {
    return { request: PROXY_DURATION_MISSING, hop };
  }
  return { request: formatDurationMs(req.traceDurationMs), hop };
}

export function proxyRequestPath(req: { path: string; error?: string }, errorMax: number): string {
  if (!req.error) {
    return req.path;
  }
  return `${req.path} — ${clipText(req.error, errorMax)}`;
}

// Prefer an exact request-id match so two hops that share a trace id do not
// steal each other's overlay metadata. Trace-id is only the fallback.
export function matchProxyRequest(
  recent: readonly ProxyRequestSnapshot[],
  want: { readonly requestId?: string; readonly traceId?: string },
): ProxyRequestSnapshot | undefined {
  const requestId = want.requestId?.trim() ?? "";
  if (requestId !== "") {
    const exact = recent.find((row) => row.requestId === requestId);
    if (exact) {
      return exact;
    }
  }
  const traceId = want.traceId?.trim() ?? "";
  if (traceId === "") {
    return undefined;
  }
  return recent.find((row) => row.traceId === traceId);
}

export type RouteLatency = {
  route: string;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
};

const NO_ROUTE = "(none)";

// Per-route latency and error counts over a window of recent proxy requests.
// The hop duration (durationMs) is what the proxy itself measured; percentiles
// are computed per route, unlike the web console which lumps every route
// together. Ordered by request count, busiest first. Requests are the only
// retained sample (the recent ring), so this is a rolling window, not lifetime.
export function routeLatencies(recent: ProxyRequestSnapshot[]): RouteLatency[] {
  const byRoute = new Map<string, { durations: number[]; errors: number }>();
  for (const req of recent) {
    const route = req.route || NO_ROUTE;
    const bucket = byRoute.get(route) ?? { durations: [], errors: 0 };
    bucket.durations.push(req.durationMs);
    if (req.error || req.status === 0 || req.status >= 500) {
      bucket.errors += 1;
    }
    byRoute.set(route, bucket);
  }
  return [...byRoute.entries()]
    .map(([route, bucket]) => ({
      route,
      count: bucket.durations.length,
      errors: bucket.errors,
      p50: Math.round(percentile(bucket.durations, 50)),
      p95: Math.round(percentile(bucket.durations, 95)),
      p99: Math.round(percentile(bucket.durations, 99)),
    }))
    .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));
}
