import type {
  ConfigSummary,
  ControlArgs,
  ControlTool,
  HttpCollection,
  HttpCollectionSummary,
  HttpBodyPage,
  HttpSendInput,
  HttpSendState,
  LogsPayload,
  LlmCallRow,
  LlmCallsPayload,
  ProfileRow,
  RequestsPayload,
  ServiceRow,
  StatusSummary,
  TracePayload,
  UpdateCheckPayload,
} from "./types.ts";
import { controlAuthHeaders } from "./session.ts";

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

export function fetchUpdate(): Promise<UpdateCheckPayload> {
  return getJson("/api/update");
}

async function httpJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...controlAuthHeaders() },
  });
  const text = await res.text();
  let body: unknown = {};
  if (text !== "") {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new Error(text || `${res.status} ${path}`);
    }
  }
  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `${res.status} ${path}`;
    throw new Error(message);
  }
  return body as T;
}

export function fetchHttpCollections(): Promise<{ collections: HttpCollectionSummary[] }> {
  return httpJson("/api/http/collections");
}

export function fetchHttpCollection(id: string): Promise<HttpCollection> {
  return httpJson(`/api/http/collections/${encodeURIComponent(id)}`);
}

export async function startHttpSend(input: HttpSendInput): Promise<string> {
  const body = await httpJson<{ id: string }>("/api/http/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return body.id;
}

export function fetchHttpResult(id: string): Promise<HttpSendState> {
  return httpJson(`/api/http/result/${encodeURIComponent(id)}`);
}

export function fetchHttpBody(id: string, offset = 0, limit?: number): Promise<HttpBodyPage> {
  const query = new URLSearchParams({ offset: String(offset) });
  if (limit !== undefined) {
    query.set("limit", String(limit));
  }
  return httpJson(`/api/http/body/${encodeURIComponent(id)}?${query.toString()}`);
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
  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `${res.status} /api/control`;
    throw new Error(message);
  }
  return body;
}
