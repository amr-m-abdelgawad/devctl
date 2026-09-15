// Small JSON-shape helpers shared by the LLM body mappers (litellm-map.ts,
// proxy-capture-map.ts). Kept in one place so the two mappers cannot drift.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function dropEmptyBody(value: unknown): unknown {
  if (value === undefined || value === null || value === "" || value === "{}") {
    return undefined;
  }
  return value;
}

// Parse a value that may already be an object, a JSON string, or an empty
// placeholder. Non-strings pass through dropEmptyBody; unparseable strings are
// returned as-is; empty / "{}" bodies become undefined.
export function parseJsonish(value: unknown): unknown {
  if (typeof value !== "string") {
    return dropEmptyBody(value);
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "{}") {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

// First key that holds a non-empty string (numbers coerced to string), else "".
export function firstString(row: Record<string, unknown> | undefined, keys: string[]): string {
  if (!row) {
    return "";
  }
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

// First key that holds a finite number (numeric strings coerced), else undefined.
export function firstNumber(row: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!row) {
    return undefined;
  }
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}
