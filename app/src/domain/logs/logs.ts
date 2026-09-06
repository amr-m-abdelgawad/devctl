export const MAX_LOG_PAGE_SIZE = 5_000;
export const DEFAULT_LOG_PAGE_SIZE = 500;
export const LevelTrace = "TRACE";
export const LevelDebug = "DEBUG";
export const LevelInfo = "INFO";
export const LevelWarn = "WARN";
export const LevelError = "ERROR";
export const LevelFatal = "FATAL";
export const LevelUnknown = "UNKNOWN";

export type LogLevel =
  | typeof LevelTrace
  | typeof LevelDebug
  | typeof LevelInfo
  | typeof LevelWarn
  | typeof LevelError
  | typeof LevelFatal
  | typeof LevelUnknown
  | string;

const LEVEL_ORDER: Record<string, number> = {
  [LevelTrace]: 0,
  [LevelDebug]: 1,
  [LevelInfo]: 2,
  [LevelWarn]: 3,
  [LevelError]: 4,
  [LevelFatal]: 5,
  [LevelUnknown]: 2,
};

export type LogEvent = {
  timestamp: string;
  service: string;
  source: string;
  level: LogLevel;
  message: string;
  pid: number;
  stream?: string;
  request_id?: string;
  identity?: string;
  // Original line, set only when `message` was extracted from a structured
  // (JSON-per-line) log — lets the details view show the full payload even
  // though the list shows just the human-readable message.
  raw?: string;
  // Assigned by LogManager.append(), monotonically increasing within one
  // daemon session (never reused, never reassigned on ring-buffer eviction).
  // Cursor-based pagination pages by this instead of by timestamp, since
  // multiple events can share a millisecond but never a sequence number.
  seq: number;
};

export type LogParser = {
  name: string;
  parse: (line: string) => Partial<LogEvent> | undefined;
};

export function defaultLogParser(): LogParser {
  return {
    name: "default",
    parse: (line) => {
      const structured = parseJSONLogLine(line);
      if (structured) {
        return structured;
      }
      return {
        level: parseLevel(line),
        request_id: parseRequestID(line) || undefined,
      };
    },
  };
}

// Structured loggers (pino, bunyan, zap, logrus, and similar) emit one JSON
// object per line; devctl otherwise shows that whole object as the message.
const JSON_MESSAGE_KEYS = ["message", "msg", "text", "log", "event"];
const JSON_LEVEL_KEYS = ["level", "severity", "levelname", "loglevel", "lvl"];
const JSON_REQUEST_ID_KEYS = ["request_id", "requestId", "trace_id", "traceId", "correlation_id", "correlationId"];

// pino's numeric level convention.
const NUMERIC_LEVELS: Record<number, LogLevel> = {
  10: LevelTrace,
  20: LevelDebug,
  30: LevelInfo,
  40: LevelWarn,
  50: LevelError,
  60: LevelFatal,
};

function firstStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function jsonLogLevel(obj: Record<string, unknown>): LogLevel | undefined {
  for (const key of JSON_LEVEL_KEYS) {
    const value = obj[key];
    if (typeof value === "number") {
      const named = NUMERIC_LEVELS[value];
      if (named) {
        return named;
      }
      continue;
    }
    if (typeof value === "string" && value.trim() !== "") {
      return value.toUpperCase();
    }
  }
  return undefined;
}

export function parseJSONLogLine(line: string): Partial<LogEvent> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const message = firstStringField(obj, JSON_MESSAGE_KEYS);
  const level = jsonLogLevel(obj);
  const requestId = firstStringField(obj, JSON_REQUEST_ID_KEYS);
  if (message === undefined && level === undefined && requestId === undefined) {
    return undefined;
  }
  return { message: message ?? trimmed, level, request_id: requestId, raw: trimmed };
}

export type LogFilter = {
  services?: string[];
  level?: string;
  source?: string;
  search?: string;
  regex?: boolean;
  since?: string;
  until?: string;
};

const REQUEST_ID_RE = /(?:x-devctl-request-id|request[_-]?id)[=: ]+([A-Za-z0-9-]+)/i;
const LEVEL_PATTERNS: Array<{ re: RegExp; level: LogLevel }> = [
  { re: /\b(fatal|critical)\b/i, level: LevelFatal },
  { re: /\b(error|err)\b/i, level: LevelError },
  { re: /\b(warn|warning)\b/i, level: LevelWarn },
  { re: /\b(debug|dbg)\b/i, level: LevelDebug },
  { re: /\b(trace)\b/i, level: LevelTrace },
  { re: /\b(info|information)\b/i, level: LevelInfo },
];

export function parseLevel(line: string): LogLevel {
  const found = LEVEL_PATTERNS.find((p) => p.re.test(line));
  return found?.level ?? LevelUnknown;
}

export function parseRequestID(line: string): string {
  const match = REQUEST_ID_RE.exec(line);
  return match?.[1] ?? "";
}

export function matchLog(filter: LogFilter, ev: LogEvent): boolean {
  if (filter.services && filter.services.length > 0 && !filter.services.includes(ev.service)) {
    return false;
  }
  if (filter.level && (LEVEL_ORDER[ev.level] ?? 2) < (LEVEL_ORDER[filter.level] ?? 2)) {
    return false;
  }
  if (filter.source && ev.source !== filter.source) {
    return false;
  }
  if (filter.since && ev.timestamp < filter.since) {
    return false;
  }
  if (filter.until && ev.timestamp > filter.until) {
    return false;
  }
  if (!filter.search) {
    return true;
  }
  if (filter.regex) {
    const re = compileLogSearch(filter.search);
    if (re) {
      return re.test(ev.message) || (ev.raw !== undefined && re.test(ev.raw));
    }
  }
  const needle = filter.search.toLowerCase();
  return ev.message.toLowerCase().includes(needle) || (ev.raw !== undefined && ev.raw.toLowerCase().includes(needle));
}

const MAX_LOG_SEARCH_REGEX = 200;
const MAX_LOG_REGEX_QUANTIFIERS = 8;
const MAX_LOG_REGEX_DEPTH = 2;

type RegexAtom = "none" | "atom" | "quantified-group" | "quant";

type RegexParser = {
  readonly raw: string;
  i: number;
  readonly out: string[];
  quantifiers: number;
  depth: number;
  lastAtom: RegexAtom;
  readonly groupQuant: boolean[];
};

export function compileLogSearch(pattern: string): RegExp | undefined {
  const source = rewriteLogRegex(pattern);
  if (source === undefined) {
    return undefined;
  }
  return new RegExp(source);
}

function rewriteLogRegex(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_LOG_SEARCH_REGEX) {
    return undefined;
  }
  const parser: RegexParser = {
    raw,
    i: 0,
    out: [],
    quantifiers: 0,
    depth: 0,
    lastAtom: "none",
    groupQuant: [],
  };
  if (!parseRegexBody(parser) || parser.i !== raw.length || parser.depth !== 0) {
    return undefined;
  }
  return parser.out.join("");
}

function parseRegexBody(parser: RegexParser): boolean {
  while (parser.i < parser.raw.length) {
    if (parser.raw[parser.i] === ")") {
      return true;
    }
    if (!parseRegexPart(parser)) {
      return false;
    }
  }
  return true;
}

function parseRegexPart(parser: RegexParser): boolean {
  const ch = parser.raw[parser.i] ?? "";
  if (ch === "|") {
    return emitOp(parser, "|", "none");
  }
  if (ch === "^") {
    return emitOp(parser, "^", "none");
  }
  if (ch === "$") {
    return emitOp(parser, "$", "none");
  }
  if (ch === ".") {
    return emitOp(parser, ".", "atom");
  }
  if (ch === "(") {
    return parseGroup(parser);
  }
  if (ch === "[") {
    return parseClass(parser);
  }
  if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
    return parseQuantifier(parser);
  }
  if (ch === "\\") {
    return parseEscape(parser);
  }
  parser.out.push(RegExp.escape(ch));
  parser.i += 1;
  parser.lastAtom = "atom";
  return true;
}

function emitOp(parser: RegexParser, op: string, atom: RegexAtom): boolean {
  parser.out.push(op);
  parser.i += 1;
  parser.lastAtom = atom;
  return true;
}

function parseGroup(parser: RegexParser): boolean {
  parser.i += 1;
  parser.depth += 1;
  if (parser.depth > MAX_LOG_REGEX_DEPTH) {
    return false;
  }
  parser.groupQuant.push(false);
  parser.out.push("(?:");
  if (!parseRegexBody(parser) || parser.raw[parser.i] !== ")") {
    return false;
  }
  parser.out.push(")");
  parser.i += 1;
  parser.depth -= 1;
  const innerQuant = parser.groupQuant.pop() === true;
  parser.lastAtom = innerQuant ? "quantified-group" : "atom";
  return true;
}

function parseQuantifier(parser: RegexParser): boolean {
  const ch = parser.raw[parser.i] ?? "";
  if (ch === "{" || parser.lastAtom === "none" || parser.lastAtom === "quant" || parser.lastAtom === "quantified-group") {
    return false;
  }
  if (parser.quantifiers >= MAX_LOG_REGEX_QUANTIFIERS) {
    return false;
  }
  if (ch === "*") {
    parser.out.push("*");
  } else if (ch === "+") {
    parser.out.push("+");
  } else if (ch === "?") {
    parser.out.push("?");
  } else {
    return false;
  }
  parser.i += 1;
  parser.quantifiers += 1;
  const parent = parser.groupQuant.length - 1;
  if (parent >= 0) {
    parser.groupQuant[parent] = true;
  }
  if (parser.raw[parser.i] === "?") {
    parser.out.push("?");
    parser.i += 1;
  }
  parser.lastAtom = "quant";
  return true;
}

function parseClass(parser: RegexParser): boolean {
  parser.i += 1;
  parser.out.push("[");
  if (parser.raw[parser.i] === "^") {
    parser.out.push("^");
    parser.i += 1;
  }
  if (parser.raw[parser.i] === "]") {
    parser.out.push(RegExp.escape("]"));
    parser.i += 1;
  }
  while (parser.i < parser.raw.length && parser.raw[parser.i] !== "]") {
    const ch = parser.raw[parser.i] ?? "";
    if (ch === "\\") {
      if (!parseEscape(parser)) {
        return false;
      }
    } else if (ch === "-") {
      parser.out.push("-");
      parser.i += 1;
    } else {
      parser.out.push(RegExp.escape(ch));
      parser.i += 1;
    }
  }
  if (parser.raw[parser.i] !== "]") {
    return false;
  }
  parser.out.push("]");
  parser.i += 1;
  parser.lastAtom = "atom";
  return true;
}

function parseEscape(parser: RegexParser): boolean {
  const next = parser.raw[parser.i + 1];
  if (next === undefined) {
    return false;
  }
  if (next === "d") {
    parser.out.push("\\d");
  } else if (next === "D") {
    parser.out.push("\\D");
  } else if (next === "w") {
    parser.out.push("\\w");
  } else if (next === "W") {
    parser.out.push("\\W");
  } else if (next === "s") {
    parser.out.push("\\s");
  } else if (next === "S") {
    parser.out.push("\\S");
  } else if (next === "n") {
    parser.out.push("\\n");
  } else if (next === "t") {
    parser.out.push("\\t");
  } else if (next === "r") {
    parser.out.push("\\r");
  } else if (next === "b") {
    parser.out.push("\\b");
  } else if (next === "B") {
    parser.out.push("\\B");
  } else {
    parser.out.push(RegExp.escape(next));
  }
  parser.i += 2;
  parser.lastAtom = "atom";
  return true;
}

export type LogPageDirection = "forward" | "backward";

export type LogPageRequest = {
  cursor?: string;
  // "backward" (the default when a cursor is given) pages toward older
  // events; "forward" pages toward newer ones. Irrelevant with no cursor —
  // that always returns the latest page.
  direction?: LogPageDirection;
  limit?: number;
};

export type LogPage = {
  // Always in ascending sequence (chronological) order, regardless of
  // paging direction.
  events: LogEvent[];
  nextCursor: string;
  prevCursor: string;
  hasNext: boolean;
  hasPrev: boolean;
  // True when a cursor was given but named a prior daemon session (a
  // restart happened since it was issued); the cursor is then ignored and
  // this page is the latest one, same as no cursor at all.
  sessionChanged: boolean;
};

export type LogFacets = {
  // Every active filter applied, exactly like query()'s own result count.
  total: number;
  // Each of these applies every *other* active filter but not its own
  // dimension — byService, for instance, still respects the current level/
  // source/search/since/until filters, just not a services filter, so it
  // answers "how many would match per service under my other filters" for
  // a service-picker UI to show without the user first clearing anything.
  byService: Record<string, number>;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
};

export function clampLogPageSize(limit?: number): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return DEFAULT_LOG_PAGE_SIZE;
  }
  return Math.min(limit as number, MAX_LOG_PAGE_SIZE);
}

