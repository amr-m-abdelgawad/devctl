// Documented JSONPath subset: optional `$` / `$.` prefix, `.` segments, and
// `[n]` indexes. No `$..`, filters, or wildcards. Recipe output paths omit `$`
// and stay relative to the parsed document they already pass in.

type PathToken = { kind: "key"; value: string } | { kind: "index"; index: number };

export function getJsonPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "$") {
    return value;
  }
  const body = stripRoot(trimmed);
  if (body === undefined) {
    return undefined;
  }
  const tokens = tokenizeJsonPath(body);
  if (tokens === undefined) {
    return undefined;
  }
  let current = value;
  for (const token of tokens) {
    current = stepJsonPath(current, token);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function stripRoot(path: string): string | undefined {
  if (path.startsWith("$.")) {
    return path.slice(2);
  }
  if (path.startsWith("$[")) {
    return path.slice(1);
  }
  if (path.startsWith("$")) {
    return undefined;
  }
  return path;
}

function tokenizeJsonPath(path: string): PathToken[] | undefined {
  if (path === "" || path.startsWith(".") || path.endsWith(".")) {
    return undefined;
  }
  const tokens: PathToken[] = [];
  let i = 0;
  while (i < path.length) {
    const next = readToken(path, i);
    if (next === undefined) {
      return undefined;
    }
    tokens.push(next.token);
    i = next.index;
  }
  return tokens.length === 0 ? undefined : tokens;
}

function readToken(path: string, start: number): { token: PathToken; index: number } | undefined {
  if (path[start] === ".") {
    if (start === 0 || start === path.length - 1 || path[start + 1] === "." || path[start + 1] === "[") {
      return undefined;
    }
    return readToken(path, start + 1);
  }
  if (path[start] === "[") {
    return readIndexToken(path, start);
  }
  return readKeyToken(path, start);
}

function readIndexToken(path: string, start: number): { token: PathToken; index: number } | undefined {
  const end = path.indexOf("]", start);
  if (end < 0) {
    return undefined;
  }
  const inner = path.slice(start + 1, end);
  if (!/^\d+$/.test(inner)) {
    return undefined;
  }
  return { token: { kind: "index", index: Number(inner) }, index: end + 1 };
}

function readKeyToken(path: string, start: number): { token: PathToken; index: number } | undefined {
  let end = start;
  while (end < path.length && path[end] !== "." && path[end] !== "[") {
    end += 1;
  }
  if (end === start) {
    return undefined;
  }
  return { token: { kind: "key", value: path.slice(start, end) }, index: end };
}

function stepJsonPath(current: unknown, token: PathToken): unknown {
  if (current === null || current === undefined) {
    return undefined;
  }
  if (token.kind === "index") {
    if (!Array.isArray(current)) {
      return undefined;
    }
    return current[token.index];
  }
  if (typeof current !== "object" || Array.isArray(current)) {
    return undefined;
  }
  return (current as Record<string, unknown>)[token.value];
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
