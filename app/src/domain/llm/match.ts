import { LLM_STATUS_ERROR, type LlmCall, type LlmCallFilter } from "./types.ts";

export function matchesLlmCall(filter: LlmCallFilter, call: LlmCall): boolean {
  if (filter.source && call.source !== filter.source) {
    return false;
  }
  if (filter.sourceType && call.sourceType !== filter.sourceType) {
    return false;
  }
  if (filter.model && call.model !== filter.model && call.routedModel !== filter.model) {
    return false;
  }
  if (filter.status && call.status !== filter.status) {
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
    return llmCallSearchText(call).toLowerCase().includes(needle);
  }
  return true;
}

export function llmCallSearchText(call: LlmCall): string {
  const parts = [
    call.id,
    call.source,
    call.model,
    call.routedModel ?? "",
    call.error ?? "",
    call.status,
    stringifyUnknown(call.request),
    stringifyUnknown(call.response),
  ];
  return parts.join(" ");
}

export function isLlmErrorStatus(status: LlmCall["status"]): boolean {
  return status === LLM_STATUS_ERROR;
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
