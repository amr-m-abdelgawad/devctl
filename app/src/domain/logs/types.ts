export const MAX_LOG_PAGE_SIZE = 5_000;
export const DEFAULT_LOG_PAGE_SIZE = 500;
export const MAX_LOG_LINE_CHARS = 16 * 1024;
export const MAX_JSON_LOG_BYTES = 64 * 1024;
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

export const LEVEL_ORDER: Record<string, number> = {
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

export type LogFilter = {
  services?: string[];
  level?: string;
  source?: string;
  search?: string;
  regex?: boolean;
  since?: string;
  until?: string;
};

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
