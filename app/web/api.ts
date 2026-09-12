import type {
  ConfigSummary,
  LogsPayload,
  ProfileRow,
  RequestsPayload,
  ServiceRow,
  StatusSummary,
  TracePayload,
} from "./types.ts";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error || `${res.status} ${path}`);
  }
  return res.json() as Promise<T>;
}

export function fetchStatus(): Promise<StatusSummary> {
  return getJson("/api/status");
}

export function fetchServices(): Promise<ServiceRow[]> {
  return getJson("/api/services");
}

export function fetchRequests(): Promise<RequestsPayload> {
  return getJson("/api/requests");
}

export function fetchConfig(): Promise<ConfigSummary> {
  return getJson("/api/config");
}

export function fetchProfiles(): Promise<ProfileRow[]> {
  return getJson("/api/profiles");
}

export function fetchLogs(params: Record<string, string> = {}): Promise<LogsPayload> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== "") {
      query.set(key, value);
    }
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return getJson(`/api/logs${suffix}`);
}

export function fetchTrace(traceId: string): Promise<TracePayload> {
  return getJson(`/api/trace/${encodeURIComponent(traceId)}`);
}

export function fetchRequestTrace(requestId: string): Promise<TracePayload> {
  return getJson(`/api/request/${encodeURIComponent(requestId)}`);
}
