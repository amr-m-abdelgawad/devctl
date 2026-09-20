import type { DoctorCheck, DoctorReport, DoctorSeverity, LogFacets, LogRow, LogsPayload, LogsQuery } from "./types.ts";

export const DEFAULT_MAX_MEMORY_EVENTS = 50_000;
export const INITIAL_LOG_PAGE_LIMIT = 500;
export const FOLLOW_POLL_MS = 100;
export const FOLLOW_IDLE_POLL_MS = 1_000;
export const FOLLOW_HIDDEN_POLL_MS = 2_000;
export const FACETS_POLL_MS = 2_000;
export const CLIP_ROW_HEIGHT = 28;
export const LOG_OVERSCAN = 16;
export const LOG_FOLLOW_SLACK_PX = 24;
export const SEARCH_DEBOUNCE_MS = 300;
export const WRAP_LINE_HEIGHT = 18;
export const WRAP_CHARS_PER_LINE = 96;
export const WRAP_HEIGHT_CAP = CLIP_ROW_HEIGHT * 8;

const SEVERITY_ERROR = 17;

export const SYSTEM_LOG_NAMES = ["auth", "mcp", "devctl", "proxy"] as const;

const SYSTEM_LOG_SET = new Set<string>(SYSTEM_LOG_NAMES);

export type LogWrapMode = "clip" | "focus" | "all";
export type LogFollowAction = "snap" | "pin" | "wait";

export function isSystemLog(row: Pick<LogRow, "source" | "service">): boolean {
  return SYSTEM_LOG_SET.has(row.source) || SYSTEM_LOG_SET.has(row.service);
}

export function isErrorLog(row: Pick<LogRow, "level" | "severityText" | "severityNumber">): boolean {
  if (typeof row.severityNumber === "number" && row.severityNumber >= SEVERITY_ERROR) {
    return true;
  }
  const level = (row.level || row.severityText || "").toLowerCase();
  return level.includes("error") || level === "fatal";
}

export function logIdentity(row: LogRow, index = 0): string {
  if (typeof row.seq === "number") {
    return `seq:${row.seq}`;
  }
  return `row:${row.timestamp}:${row.service}:${index}`;
}

export function nextLogWrapMode(mode: LogWrapMode): LogWrapMode {
  if (mode === "clip") {
    return "focus";
  }
  if (mode === "focus") {
    return "all";
  }
  return "clip";
}

export function logWrapLabel(mode: LogWrapMode): string {
  if (mode === "all") {
    return "wrap all";
  }
  if (mode === "focus") {
    return "wrap selected";
  }
  return "clip";
}

export function logRowExpanded(mode: LogWrapMode, selected: boolean): boolean {
  return mode === "all" || (mode === "focus" && selected);
}

export function estimateWrappedHeight(message: string): number {
  const lines = Math.max(1, Math.ceil(message.length / WRAP_CHARS_PER_LINE));
  return Math.min(WRAP_HEIGHT_CAP, Math.max(CLIP_ROW_HEIGHT, lines * WRAP_LINE_HEIGHT + 10));
}

export function followPollDelay(opts: { idle: boolean; hidden: boolean }): number {
  if (opts.hidden) {
    return FOLLOW_HIDDEN_POLL_MS;
  }
  if (opts.idle) {
    return FOLLOW_IDLE_POLL_MS;
  }
  return FOLLOW_POLL_MS;
}

export function isLogFollowBottom(scrollTop: number, viewHeight: number, scrollHeight: number, slack = LOG_FOLLOW_SLACK_PX): boolean {
  if (viewHeight <= 0) {
    return true;
  }
  return scrollTop + viewHeight >= scrollHeight - slack;
}

export function logFollowMaxScroll(scrollHeight: number, viewHeight: number): number {
  return Math.max(0, scrollHeight - Math.max(0, viewHeight));
}

export function nextLogFollowAction(input: {
  readonly follow: boolean;
  readonly armed: boolean;
  readonly atBottom: boolean;
  readonly scrolledUp: boolean;
  readonly contentGrew: boolean;
  readonly contentShrunk: boolean;
}): { action: LogFollowAction; armed: boolean } {
  if (!input.follow) {
    return { action: "wait", armed: false };
  }
  if (input.atBottom) {
    return { action: "wait", armed: true };
  }
  const layoutChanged = input.contentGrew || input.contentShrunk;
  if (input.scrolledUp && !layoutChanged) {
    return { action: "pin", armed: true };
  }
  if (layoutChanged) {
    return { action: "snap", armed: true };
  }
  if (!input.armed) {
    return { action: "wait", armed: false };
  }
  return { action: "pin", armed: true };
}

export function visibleIndexRange(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0 };
  }
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + overscan * 2;
  return { start, end: Math.min(count, start + visible) };
}

export function indexAtOffset(offsets: readonly number[], offset: number): number {
  const last = Math.max(0, offsets.length - 2);
  let low = 0;
  let high = last;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    const value = offsets[mid] ?? 0;
    if (value <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

export function rowOffsets(count: number, heightAt: (index: number) => number): number[] {
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let index = 0; index < count; index += 1) {
    offsets[index + 1] = (offsets[index] ?? 0) + heightAt(index);
  }
  return offsets;
}

export function mergeLoadedPage(current: LogRow[], page: LogRow[]): LogRow[] {
  const tail = page[page.length - 1];
  const tailSeq = typeof tail?.seq === "number" ? tail.seq : -1;
  const newer = current.filter((event) => typeof event.seq === "number" && event.seq > tailSeq);
  return [...page, ...newer];
}

export function prependOlderPage(current: LogRow[], older: LogRow[]): LogRow[] {
  if (older.length === 0) {
    return current;
  }
  const known = new Set(current.map((event) => event.seq));
  const fresh = older.filter((event) => !known.has(event.seq));
  return fresh.length === 0 ? current : [...fresh, ...current];
}

export function appendFollowEvents(current: LogRow[], incoming: LogRow[], since: string, cap: number): LogRow[] {
  const accepted = since === "" ? incoming : incoming.filter((event) => event.timestamp >= since);
  if (accepted.length === 0) {
    return current;
  }
  const known = new Set(
    current.flatMap((row) => (typeof row.seq === "number" && row.seq > 0 ? [row.seq] : [])),
  );
  const replacements = new Map<number, LogRow>();
  const fresh: LogRow[] = [];
  const freshIndexes = new Map<number, number>();
  for (const event of accepted) {
    const seq = event.seq;
    if (typeof seq === "number" && seq > 0 && known.has(seq)) {
      replacements.set(seq, event);
    } else if (typeof seq === "number" && seq > 0) {
      const index = freshIndexes.get(seq);
      if (index === undefined) {
        freshIndexes.set(seq, fresh.length);
        fresh.push(event);
      } else {
        fresh[index] = event;
      }
    } else {
      fresh.push(event);
    }
  }
  const merged = replacements.size === 0
    ? current
    : current.map((row) => (typeof row.seq === "number" ? replacements.get(row.seq) ?? row : row));
  if (fresh.length === 0) {
    return merged;
  }
  const limit = Math.max(1, cap);
  if (fresh.length >= limit) {
    return fresh.slice(-limit);
  }
  const drop = Math.max(0, merged.length + fresh.length - limit);
  return merged.slice(drop).concat(fresh);
}

export function filterLogRows(
  events: LogRow[],
  opts: {
    service?: string;
    errorOnly?: boolean;
    search?: string;
    regex?: boolean;
    showSystem?: boolean;
    since?: string;
  },
): LogRow[] {
  const service = opts.service ?? "";
  const search = (opts.search ?? "").trim();
  const since = opts.since ?? "";
  const matcher = searchMatcher(search, opts.regex === true);
  return events.filter((event) => {
    if (service !== "" && event.service !== service) {
      return false;
    }
    if (opts.showSystem === false && isSystemLog(event)) {
      return false;
    }
    if (since !== "" && event.timestamp < since) {
      return false;
    }
    if (opts.errorOnly === true && !isErrorLog(event)) {
      return false;
    }
    if (!matcher) {
      return true;
    }
    return matcher(event.message) || matcher(event.service) || matcher(event.source);
  });
}

function searchMatcher(search: string, regex: boolean): ((text: string) => boolean) | undefined {
  if (search === "") {
    return undefined;
  }
  if (regex) {
    const compiled = compileLogSearch(search);
    if (compiled) {
      return (text) => compiled.test(text);
    }
  }
  const needle = search.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

function compileLogSearch(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "i");
  } catch {
    return undefined;
  }
}

export function facetServiceChips(
  facets: LogFacets | undefined,
  names: string[],
  events: LogRow[] = [],
): Array<{ name: string; count: number }> {
  const byService = facets?.byService ?? serviceCounts(events);
  const known = names.map((name) => ({ name, count: byService[name] ?? 0 }));
  const extra = Object.keys(byService)
    .filter((name) => !names.includes(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, count: byService[name] ?? 0 }));
  const listed = [...known, ...extra];
  const total = typeof facets?.total === "number"
    ? facets.total
    : listed.reduce((sum, row) => sum + row.count, 0);
  return [{ name: "", count: total }, ...listed];
}

function serviceCounts(events: LogRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.service !== "") {
      counts[event.service] = (counts[event.service] ?? 0) + 1;
    }
  }
  return counts;
}

export function countNewerThan(events: LogRow[], pinSeq: number | undefined): number {
  if (typeof pinSeq !== "number") {
    return 0;
  }
  return events.reduce((sum, event) => sum + (typeof event.seq === "number" && event.seq > pinSeq ? 1 : 0), 0);
}

export function lastSeq(events: LogRow[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const seq = events[index]?.seq;
    if (typeof seq === "number") {
      return seq;
    }
  }
  return undefined;
}

export function liveLogsQuery(opts: {
  service?: string;
  errorOnly?: boolean;
  search?: string;
  regex?: boolean;
  since?: string;
}): LogsQuery {
  const query: LogsQuery = {};
  if (opts.service) {
    query.service = opts.service;
  }
  if (opts.errorOnly) {
    query.level = "ERROR";
  }
  if (opts.search) {
    query.search = opts.search;
  }
  if (opts.regex) {
    query.regex = true;
  }
  if (opts.since) {
    query.since = opts.since;
  }
  return query;
}

export function logsQueryKey(query: LogsQuery): string {
  return JSON.stringify([
    query.service ?? "",
    query.level ?? "",
    query.search ?? "",
    query.regex === true,
    query.source ?? "",
    query.since ?? "",
    query.until ?? "",
  ]);
}

export function encodeLogsQuery(query: LogsQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.service) {
    params.service = query.service;
  }
  if (query.level) {
    params.level = query.level;
  }
  if (query.search) {
    params.search = query.search;
  }
  if (query.regex) {
    params.regex = "true";
  }
  if (query.source) {
    params.source = query.source;
  }
  if (query.since) {
    params.since = query.since;
  }
  if (query.until) {
    params.until = query.until;
  }
  if (query.cursor) {
    params.cursor = query.cursor;
  }
  if (query.direction) {
    params.direction = query.direction;
  }
  if (typeof query.limit === "number") {
    params.limit = String(query.limit);
  }
  return params;
}

export function queryString(params: Record<string, string>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== "") {
      query.set(key, value);
    }
  }
  return query.size > 0 ? `?${query.toString()}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCountMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isFinite(count)) {
      counts[key] = count;
    }
  }
  return counts;
}

export function normalizeLogsPayload(payload: unknown): LogsPayload {
  const row = isRecord(payload) ? payload : {};
  const events = Array.isArray(row.events) ? row.events.filter(isLogRowLike) : [];
  return {
    events,
    truncated: row.truncated === true,
    has_more: row.has_more === true || row.hasMore === true,
    next_cursor: asString(row.next_cursor ?? row.nextCursor),
    prev_cursor: asString(row.prev_cursor ?? row.prevCursor),
    session_changed: row.session_changed === true || row.sessionChanged === true,
  };
}

function isLogRowLike(value: unknown): value is LogRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.timestamp === "string" && typeof value.message === "string";
}

export function normalizeFacets(payload: unknown): LogFacets {
  const row = isRecord(payload) ? payload : {};
  return {
    total: typeof row.total === "number" && Number.isFinite(row.total) ? row.total : 0,
    byService: asCountMap(row.byService ?? row.by_service),
    byLevel: asCountMap(row.byLevel ?? row.by_level),
    bySource: asCountMap(row.bySource ?? row.by_source),
  };
}

export function sessionIdsFrom(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is string => typeof item === "string" && item !== "");
  }
  if (!isRecord(payload)) {
    return [];
  }
  const list = Array.isArray(payload.sessions) ? payload.sessions : Array.isArray(payload.ids) ? payload.ids : [];
  return list.filter((item): item is string => typeof item === "string" && item !== "");
}

function asSeverity(value: unknown): DoctorSeverity {
  if (value === "warn" || value === "error" || value === "ok") {
    return value;
  }
  return "ok";
}

function normalizeCheck(value: unknown): DoctorCheck | undefined {
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined;
  }
  const actionRaw = isRecord(value.action) ? value.action : undefined;
  const holderRaw = actionRaw && isRecord(actionRaw.holder) ? actionRaw.holder : undefined;
  const holder = holderRaw && typeof holderRaw.port === "number" && typeof holderRaw.pid === "number"
    ? {
      port: holderRaw.port,
      pid: holderRaw.pid,
      command: asString(holderRaw.command),
    }
    : undefined;
  return {
    name: value.name,
    severity: asSeverity(value.severity),
    message: asString(value.message),
    hint: asString(value.hint) || undefined,
    action: actionRaw?.kind === "free-port" && holder ? { kind: "free-port", holder } : undefined,
  };
}

export function normalizeDoctorReport(payload: unknown): DoctorReport {
  const row = isRecord(payload) ? payload : {};
  const checks = Array.isArray(row.checks)
    ? row.checks.map(normalizeCheck).filter((check): check is DoctorCheck => check !== undefined)
    : [];
  return {
    checks,
    issues: typeof row.issues === "number" && Number.isFinite(row.issues) ? row.issues : 0,
  };
}

export function exportFilename(header: string | null): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header ?? "");
  const name = match?.[1]?.trim() ?? "";
  return name === "" ? "devctl-logs.jsonl" : name;
}
