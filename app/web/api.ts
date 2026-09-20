import {
  encodeLogsQuery,
  exportFilename,
  normalizeDoctorReport,
  normalizeFacets,
  normalizeLogsPayload,
  queryString,
  sessionIdsFrom,
} from "./logs.ts";
import type {
  ConfigSummary,
  ControlArgs,
  ControlTool,
  DoctorReport,
  LogFacets,
  LogsPayload,
  LogsQuery,
  LlmCallRow,
  LlmCallsPayload,
  PreferenceSnapshot,
  ProfileRow,
  RequestsPayload,
  ServiceRow,
  StatusSummary,
  TracePayload,
  TrafficCallRow,
  TrafficCallsPayload,
  UpdateCheckPayload,
} from "./types.ts";
import { controlAuthHeaders, forgetControlToken } from "./session.ts";

const HTTP_UNAUTHORIZED = 401;

function rejectUnlessOk(res: Response, fallback: string, bodyError?: string): void {
  if (res.status === HTTP_UNAUTHORIZED) {
    forgetControlToken();
  }
  if (!res.ok) {
    throw new Error(bodyError || `${res.status} ${fallback}`);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: controlAuthHeaders() });
  const body = res.ok ? undefined : await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
  rejectUnlessOk(res, path, body?.error);
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

export async function fetchLogs(params: LogsQuery = {}): Promise<LogsPayload> {
  const payload: unknown = await getJson(`/api/logs${queryString(encodeLogsQuery(params))}`);
  return normalizeLogsPayload(payload);
}

export async function fetchLogStats(params: LogsQuery = {}): Promise<LogFacets> {
  const payload: unknown = await getJson(`/api/logs/stats${queryString(encodeLogsQuery(params))}`);
  return normalizeFacets(payload);
}

export async function fetchLogSessions(): Promise<string[]> {
  const payload: unknown = await getJson("/api/logs/sessions");
  return sessionIdsFrom(payload);
}

export async function fetchLogSession(id: string, params: LogsQuery = {}): Promise<LogsPayload> {
  const path = `/api/logs/sessions/${encodeURIComponent(id)}${queryString(encodeLogsQuery(params))}`;
  const payload: unknown = await getJson(path);
  return normalizeLogsPayload(payload);
}

export async function fetchDoctor(): Promise<DoctorReport> {
  const payload: unknown = await getJson("/api/doctor");
  return normalizeDoctorReport(payload);
}

export async function downloadLogsExport(params: LogsQuery = {}): Promise<void> {
  const path = `/api/logs/export${queryString(encodeLogsQuery(params))}`;
  const res = await fetch(path, { headers: controlAuthHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    rejectUnlessOk(res, path, body?.error);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportFilename(res.headers.get("content-disposition"));
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function fetchTrace(traceId: string): Promise<TracePayload> {
  return getJson(`/api/trace/${encodeURIComponent(traceId)}`);
}

export function fetchRequestTrace(requestId: string): Promise<TracePayload> {
  return getJson(`/api/request/${encodeURIComponent(requestId)}`);
}

export function fetchLlmCalls(params: Record<string, string> = {}): Promise<LlmCallsPayload> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== "") {
      query.set(key, value);
    }
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return getJson(`/api/llm${suffix}`);
}

export function fetchLlmCall(id: string): Promise<LlmCallRow> {
  return getJson(`/api/llm/${encodeURIComponent(id)}`);
}

export function fetchTrafficCalls(params: Record<string, string> = {}): Promise<TrafficCallsPayload> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== "") {
      query.set(key, value);
    }
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return getJson(`/api/traffic${suffix}`);
}

export function fetchTrafficCall(id: string): Promise<TrafficCallRow> {
  return getJson(`/api/traffic/${encodeURIComponent(id)}`);
}

export function fetchUpdate(): Promise<UpdateCheckPayload> {
  return getJson("/api/update");
}

export function fetchPreferences(scope: "user" | "repo" = "repo"): Promise<PreferenceSnapshot> {
  return getJson(`/api/preferences?scope=${scope}`);
}

export async function postControl(tool: ControlTool, args: ControlArgs = {}): Promise<unknown> {
  const res = await fetch("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json", ...controlAuthHeaders() },
    body: JSON.stringify({ tool, args }),
  });
  const text = await res.text();
  let body: unknown = {};
  if (text !== "") {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new Error(text || `${res.status} /api/control`);
    }
  }
  const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error
    : undefined;
  rejectUnlessOk(res, "/api/control", message);
  return body;
}
