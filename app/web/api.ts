import type {
  ConfigSummary,
  ControlArgs,
  ControlTool,
  LogsPayload,
  LlmCallRow,
  LlmCallsPayload,
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
