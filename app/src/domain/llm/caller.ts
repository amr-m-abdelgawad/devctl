const CALLER_MAX_CHARS = 64;
const METADATA_SERVICE_KEYS = ["service", "service_name", "devctl_service"] as const;

// Reserved filter value meaning "calls with no known caller". A real caller can
// never equal this (normalizeLlmCaller rejects it), so it is unambiguous as a
// filter selector across the CLI (`--caller -`), MCP, web, and TUI.
export const LLM_CALLER_NONE = "-";

export const LLM_CALLER_HEADER = "x-devctl-service";
const LLM_CALLER_HEADER_ALIASES = [LLM_CALLER_HEADER, "x-devctl-service-name"] as const;
const LITELLM_METADATA_HEADER = "x-litellm-metadata";

export function normalizeLlmCaller(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "" || value.includes("\n") || value.includes("\r")) {
    return undefined;
  }
  // Never accept the reserved no-caller sentinel as a real caller, so a source
  // that emits a bare "-" (an unresolved shell expansion, a literal dash in
  // metadata.service) cannot both count as a caller and match the no-caller
  // filter.
  if (value === LLM_CALLER_NONE) {
    return undefined;
  }
  if (looksLikeEmail(value)) {
    return undefined;
  }
  return value.length > CALLER_MAX_CHARS ? value.slice(0, CALLER_MAX_CHARS) : value;
}

export function callerFromHeaders(headers: Record<string, string>): string | undefined {
  for (const name of LLM_CALLER_HEADER_ALIASES) {
    const found = headerValueIgnoreCase(headers, name);
    const caller = normalizeLlmCaller(found);
    if (caller !== undefined) {
      return caller;
    }
  }
  return callerFromMetadata(parseJsonObject(headerValueIgnoreCase(headers, LITELLM_METADATA_HEADER)));
}

export function isLlmCallerHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return LLM_CALLER_HEADER_ALIASES.some((alias) => alias === lower);
}

export function callerFromSpendLog(row: Record<string, unknown>, metadata: Record<string, unknown>): string | undefined {
  const tagged = callerFromMetadata(metadata);
  if (tagged !== undefined) {
    return tagged;
  }
  return firstNonEmptyString(row, ["user", "end_user"]);
}

export function callerFromCompletionRequest(request: unknown): string | undefined {
  const rec = asObject(request);
  if (rec === undefined) {
    return undefined;
  }
  const tagged = callerFromMetadata(asObject(rec.metadata));
  if (tagged !== undefined) {
    return tagged;
  }
  return firstNonEmptyString(rec, ["user"]);
}

function callerFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  return firstNonEmptyString(metadata, METADATA_SERVICE_KEYS);
}

export function headerValueIgnoreCase(headers: Record<string, string>, name: string): string {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return "";
}

function firstNonEmptyString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") {
      const caller = normalizeLlmCaller(value);
      if (caller !== undefined) {
        return caller;
      }
    }
  }
  return undefined;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  if (raw.trim() === "") {
    return undefined;
  }
  try {
    return asObject(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function looksLikeEmail(value: string): boolean {
  const at = value.indexOf("@");
  return at > 0 && at < value.length - 1;
}
