import { LLM_CALLER_NONE } from "../llm/caller.ts";
import { trafficIsError, type TrafficCall, type TrafficCallFilter, type TrafficPayload } from "./types.ts";

export function matchesTrafficCall(filter: TrafficCallFilter, call: TrafficCall): boolean {
  if (filter.route && call.route !== filter.route) {
    return false;
  }
  if (filter.transport && call.transport !== filter.transport) {
    return false;
  }
  if (filter.method && call.method.toUpperCase() !== filter.method.toUpperCase()) {
    return false;
  }
  if (filter.caller) {
    const caller = (call.caller ?? "").trim();
    if (filter.caller === LLM_CALLER_NONE ? caller !== "" : caller !== filter.caller) {
      return false;
    }
  }
  if (filter.status && !matchesTrafficStatus(filter.status, call)) {
    return false;
  }
  if (filter.since && call.timestamp < filter.since) {
    return false;
  }
  if (filter.until && call.timestamp > filter.until) {
    return false;
  }
  if (filter.requestId && call.requestId !== filter.requestId && call.id !== filter.requestId) {
    return false;
  }
  if (filter.traceId && call.traceId !== filter.traceId) {
    return false;
  }
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    return trafficCallSearchText(call).toLowerCase().includes(needle);
  }
  return true;
}

export function trafficCallSearchText(call: TrafficCall): string {
  const parts = [
    call.id,
    call.route,
    call.caller ?? "",
    call.method,
    call.path,
    call.transport,
    String(call.status),
    call.grpcStatus ?? "",
    payloadSearchText(call.request),
    payloadSearchText(call.response),
  ];
  return parts.join(" ");
}

function matchesTrafficStatus(wanted: string, call: TrafficCall): boolean {
  const needle = wanted.trim().toLowerCase();
  if (needle === "error") {
    return trafficIsError(call);
  }
  if (needle === "ok") {
    return !trafficIsError(call);
  }
  return String(call.status) === wanted.trim() || (call.grpcStatus ?? "") === wanted.trim();
}

function payloadSearchText(payload?: TrafficPayload): string {
  if (!payload) {
    return "";
  }
  return `${payload.text ?? ""} ${payload.data ?? ""} ${payload.contentType ?? ""}`;
}
