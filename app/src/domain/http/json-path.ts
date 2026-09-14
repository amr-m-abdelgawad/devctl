export function getJsonPath(value: unknown, path: string): unknown {
  if (path === "") {
    return value;
  }
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function jsonValueToString(value: unknown): string {
  if (value === undefined) {
    throw new Error("json path is missing");
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
