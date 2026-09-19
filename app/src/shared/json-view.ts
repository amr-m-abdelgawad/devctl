const JSON_PRETTY_SPACE = 2;
export const JSON_FIND_MIN = 2;
export const JSON_DEFAULT_EXPAND_DEPTH = 2;

const PREVIEW_MAX = 72;
const EMBEDDED_MIN = 2;

export type JsonTokenKind = "key" | "string" | "number" | "boolean" | "null" | "punct" | "text";

export type JsonToken = {
  readonly kind: JsonTokenKind;
  readonly text: string;
};

export type JsonType = "object" | "array" | "string" | "number" | "boolean" | "null";

export type JsonPathSegment = string | number;

export type JsonInput = {
  readonly kind: "json" | "text";
  readonly value: unknown;
  readonly pretty: string;
};

export type JsonTreeNode = {
  readonly id: string;
  readonly path: readonly JsonPathSegment[];
  readonly pathLabel: string;
  readonly key: string;
  readonly type: JsonType;
  readonly value: unknown;
  readonly preview: string;
  readonly depth: number;
  readonly expandable: boolean;
  readonly childCount: number;
  readonly matched: boolean;
};

export function prettyJson(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, JSON_PRETTY_SPACE) ?? "";
  } catch {
    return String(value);
  }
}

export function coerceJsonInput(input: unknown): JsonInput {
  if (input === undefined) {
    return { kind: "text", value: undefined, pretty: "" };
  }
  if (typeof input === "string") {
    return coerceJsonString(input);
  }
  if (isJsonValue(input)) {
    return { kind: "json", value: input, pretty: prettyJson(input) };
  }
  return { kind: "text", value: input, pretty: String(input) };
}

export function formatJsonPath(path: readonly JsonPathSegment[]): string {
  if (path.length === 0) {
    return "$";
  }
  let out = "$";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return out;
}

export function jsonTypeOf(value: unknown): JsonType {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return "object";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return "string";
}

export function tokenizeJson(pretty: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let index = 0;
  while (index < pretty.length) {
    const next = nextJsonToken(pretty, index);
    tokens.push(next.token);
    index = next.end;
  }
  return tokens;
}

export function initialCollapsedIds(
  input: unknown,
  depth = JSON_DEFAULT_EXPAND_DEPTH,
  parseEmbedded = true,
): Set<string> {
  const coerced = coerceJsonInput(input);
  if (coerced.kind !== "json") {
    return new Set();
  }
  return new Set(
    collectJsonNodes(coerced.value, new Set(), parseEmbedded, "")
      .filter((row) => row.expandable && row.depth >= depth)
      .map((row) => row.id),
  );
}

export function visibleJsonTree(input: unknown, opts: {
  collapsed?: ReadonlySet<string>;
  defaultExpandedDepth?: number;
  needle?: string;
  parseEmbedded?: boolean;
} = {}): JsonTreeNode[] {
  const coerced = coerceJsonInput(input);
  if (coerced.kind !== "json") {
    return [];
  }
  const needle = (opts.needle ?? "").trim();
  const search = needle.length >= JSON_FIND_MIN ? needle.toLowerCase() : "";
  const parseEmbedded = opts.parseEmbedded !== false;
  const collapsed = new Set(opts.collapsed ?? initialCollapsedIds(coerced.value, opts.defaultExpandedDepth, parseEmbedded));
  if (search !== "") {
    forceExpandMatches(coerced.value, collapsed, search, parseEmbedded);
  }
  return collectJsonNodes(coerced.value, collapsed, parseEmbedded, search);
}

function previewJson(value: unknown, max = PREVIEW_MAX): string {
  const type = jsonTypeOf(value);
  if (type === "object") {
    return objectPreview(value as Record<string, unknown>, max);
  }
  if (type === "array") {
    return `[${(value as unknown[]).length}]`;
  }
  const text = type === "string" ? JSON.stringify(value) : prettyScalar(value);
  return clipPreview(text, max);
}

function coerceJsonString(input: string): JsonInput {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { kind: "text", value: input, pretty: input };
  }
  try {
    const parsed: unknown = JSON.parse(input);
    if (isJsonValue(parsed)) {
      return { kind: "json", value: parsed, pretty: prettyJson(parsed) };
    }
  } catch {
    return { kind: "text", value: input, pretty: input };
  }
  return { kind: "text", value: input, pretty: input };
}

function isJsonValue(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean" || kind === "object";
}

function nextJsonToken(pretty: string, start: number): { token: JsonToken; end: number } {
  const ch = pretty[start] ?? "";
  if (ch === "\"") {
    return readJsonString(pretty, start);
  }
  if (/\s/.test(ch)) {
    return readWhile(pretty, start, isWhitespace, "text");
  }
  if (isDigitStart(pretty, start)) {
    return readWhile(pretty, start, isNumberChar, "number");
  }
  if (pretty.startsWith("true", start) && isWordEnd(pretty, start + 4)) {
    return { token: { kind: "boolean", text: "true" }, end: start + 4 };
  }
  if (pretty.startsWith("false", start) && isWordEnd(pretty, start + 5)) {
    return { token: { kind: "boolean", text: "false" }, end: start + 5 };
  }
  if (pretty.startsWith("null", start) && isWordEnd(pretty, start + 4)) {
    return { token: { kind: "null", text: "null" }, end: start + 4 };
  }
  if ("{}[],:".includes(ch)) {
    return { token: { kind: "punct", text: ch }, end: start + 1 };
  }
  return readWhile(pretty, start, isPlainText, "text");
}

function readJsonString(pretty: string, start: number): { token: JsonToken; end: number } {
  const end = stringEnd(pretty, start);
  const text = pretty.slice(start, end);
  const after = skipWs(pretty, end);
  const kind = pretty[after] === ":" ? "key" : "string";
  return { token: { kind, text }, end };
}

function readWhile(
  pretty: string,
  start: number,
  pred: (ch: string, index: number) => boolean,
  kind: JsonTokenKind,
): { token: JsonToken; end: number } {
  let end = start;
  while (end < pretty.length && pred(pretty[end] ?? "", end)) {
    end += 1;
  }
  if (end === start) {
    return { token: { kind: "text", text: pretty[start] ?? "" }, end: start + 1 };
  }
  return { token: { kind, text: pretty.slice(start, end) }, end };
}

function stringEnd(pretty: string, start: number): number {
  let index = start + 1;
  while (index < pretty.length) {
    const ch = pretty[index];
    if (ch === "\\") {
      index += 2;
    } else if (ch === "\"") {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return pretty.length;
}

function skipWs(pretty: string, start: number): number {
  let index = start;
  while (index < pretty.length && /\s/.test(pretty[index] ?? "")) {
    index += 1;
  }
  return index;
}

function isDigitStart(pretty: string, start: number): boolean {
  const ch = pretty[start] ?? "";
  if (ch >= "0" && ch <= "9") {
    return true;
  }
  return ch === "-" && isNumberChar(pretty[start + 1] ?? "", start + 1);
}

function isNumberChar(ch: string, _index: number): boolean {
  return /[0-9.eE+-]/.test(ch);
}

function isWordEnd(pretty: string, index: number): boolean {
  const ch = pretty[index];
  return ch === undefined || /[\s,}\]]/.test(ch);
}

function isWhitespace(ch: string, _index: number): boolean {
  return /\s/.test(ch);
}

function isPlainText(ch: string, _index: number): boolean {
  return !"\"{}[],:".includes(ch) && !/[0-9-]/.test(ch) && !/\s/.test(ch);
}

function collectJsonNodes(
  value: unknown,
  collapsed: ReadonlySet<string>,
  parseEmbedded: boolean,
  search: string,
): JsonTreeNode[] {
  const rows: JsonTreeNode[] = [];
  walkJson(value, [], 0, rows, { collapsed, parseEmbedded, search });
  return rows;
}

function jsonNodeId(path: readonly JsonPathSegment[]): string {
  return formatJsonPath(path);
}

function walkJson(
  value: unknown,
  path: readonly JsonPathSegment[],
  depth: number,
  out: JsonTreeNode[],
  opts: {
    collapsed: ReadonlySet<string>;
    parseEmbedded: boolean;
    search: string;
  },
): void {
  const shown = unwrapEmbedded(value, opts.parseEmbedded);
  const entries = childEntries(shown);
  const id = jsonNodeId(path);
  const expandable = entries.length > 0;
  out.push({
    id,
    path,
    pathLabel: formatJsonPath(path),
    key: pathKey(path),
    type: jsonTypeOf(shown),
    value: shown,
    preview: previewJson(shown),
    depth,
    expandable,
    childCount: entries.length,
    matched: opts.search !== "" && nodeMatches(path, shown, opts.search),
  });
  if (!expandable || opts.collapsed.has(id)) {
    return;
  }
  for (const [segment, child] of entries) {
    walkJson(child, [...path, segment], depth + 1, out, opts);
  }
}

function forceExpandMatches(value: unknown, collapsed: Set<string>, search: string, parseEmbedded: boolean): void {
  const keepOpen = new Set<string>(["$"]);
  for (const row of collectJsonNodes(value, new Set(), parseEmbedded, search)) {
    if (row.matched) {
      addAncestorIds(row.path, keepOpen);
    }
  }
  for (const id of [...collapsed]) {
    if (keepOpen.has(id)) {
      collapsed.delete(id);
    }
  }
}

function addAncestorIds(path: readonly JsonPathSegment[], keepOpen: Set<string>): void {
  let prefix: JsonPathSegment[] = [];
  keepOpen.add("$");
  for (const segment of path) {
    keepOpen.add(jsonNodeId(prefix));
    prefix = [...prefix, segment];
  }
}

function nodeMatches(path: readonly JsonPathSegment[], value: unknown, search: string): boolean {
  const key = pathKey(path).toLowerCase();
  if (key.includes(search) || formatJsonPath(path).toLowerCase().includes(search)) {
    return true;
  }
  if (typeof value === "string") {
    return value.toLowerCase().includes(search);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value).toLowerCase().includes(search);
  }
  return previewJson(value).toLowerCase().includes(search);
}

function childEntries(value: unknown): Array<[JsonPathSegment, unknown]> {
  if (Array.isArray(value)) {
    return value.map((child, index) => [index, child]);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>);
  }
  return [];
}

function unwrapEmbedded(value: unknown, parseEmbedded: boolean): unknown {
  if (!parseEmbedded || typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length < EMBEDDED_MIN) {
    return value;
  }
  const start = trimmed[0];
  if (start !== "{" && start !== "[") {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) || (parsed !== null && typeof parsed === "object") ? parsed : value;
  } catch {
    return value;
  }
}

function pathKey(path: readonly JsonPathSegment[]): string {
  if (path.length === 0) {
    return "$";
  }
  const last = path[path.length - 1];
  return last === undefined ? "$" : String(last);
}

function objectPreview(value: Record<string, unknown>, max: number): string {
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return "{}";
  }
  const listed = keys.slice(0, 3).join(", ");
  const extra = keys.length > 3 ? ", …" : "";
  return clipPreview(`{${keys.length} ${listed}${extra}}`, max);
}

function prettyScalar(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

function clipPreview(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}
