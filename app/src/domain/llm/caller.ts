const CALLER_MAX_CHARS = 64;

export const LLM_CALLER_HEADER = "x-devctl-service";
const LLM_CALLER_HEADER_ALIASES = [LLM_CALLER_HEADER, "x-devctl-service-name"] as const;

export function normalizeLlmCaller(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "" || value.includes("\n") || value.includes("\r")) {
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
  return undefined;
}

export function isLlmCallerHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return LLM_CALLER_HEADER_ALIASES.some((alias) => alias === lower);
}

export function callerFromSpendLog(row: Record<string, unknown>, metadata: Record<string, unknown>): string | undefined {
  const tagged = firstNonEmptyString(metadata, ["service", "service_name", "devctl_service"]);
  if (tagged !== undefined) {
    return tagged;
  }
  return firstNonEmptyString(row, ["user", "end_user"]);
}

export function callerFromCompletionRequest(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return undefined;
  }
  return firstNonEmptyString(request as Record<string, unknown>, ["user"]);
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

function looksLikeEmail(value: string): boolean {
  const at = value.indexOf("@");
  return at > 0 && at < value.length - 1;
}
