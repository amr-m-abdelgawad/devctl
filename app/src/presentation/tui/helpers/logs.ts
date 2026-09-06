import { compileLogSearch, LevelUnknown, type LogEvent, type LogFacets } from "../../../domain/logs/logs.ts";
import { clipText } from "./format.ts";
import { SERVICE_NAME_MAX } from "./services.ts";

export const LOG_META_COL = 8;

export const LOG_TIME_COL = 9;

export const LOG_LEVEL_COL = 7;

export const LOG_SERVICE_MIN = 10;

export const LOG_MSG_MIN = 16;

export const LOG_ROW_GUTTER = 2;

export const LOG_COL_GAP = 1;

export const LOG_LIST_TAIL = 200;

const LOG_PANE_BORDER = 2;

const LOG_SCROLLBAR = 1;

export const LOG_FOLD_MARK = "▸";

// Most plain stdout/stderr lines carry no level keyword at all, so LevelUnknown
// is the common case, not an anomaly — showing it as a loud "UNKNOWN" reads as
// something being wrong. A dash matches how the rest of the UI already shows
// "no value" (pid —, port —, identity —).
export function displayLogLevel(level: string): string {
  return level === LevelUnknown ? "—" : level;
}

const LOG_GAPS = 2;

const LOG_WRAP_BIAS = 0.4;

export type LogWrapMode = "clip" | "focus" | "all";

export function logPaneInnerWidth(width: number, pad: number, fullscreen: boolean): number {
  const chrome = fullscreen ? LOG_SCROLLBAR : LOG_PANE_BORDER + LOG_SCROLLBAR + Math.max(0, pad) * 2;
  return Math.max(1, width - chrome);
}

export type LogFold = {
  readonly visible: string[];
  readonly mark: string;
  readonly folded: boolean;
  readonly hidden: number;
};

export type LogSpanKind = "text" | "string" | "keyword" | "number";

export type LogSpan = {
  text: string;
  kind: LogSpanKind;
};

const LOG_TOKEN = /("[^"]*"|'[^']*'|\b(?:ERROR|FATAL|WARN(?:ING)?|FAIL(?:ED)?)\b|\b\d{3,5}\b)/gi;

function logSpanKind(token: string): LogSpanKind {
  if (token.startsWith("\"") || token.startsWith("'")) {
    return "string";
  }
  if (/^\d+$/.test(token)) {
    return "number";
  }
  return "keyword";
}

const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI, "");
}

// event.raw holds the original line for a structured (JSON) log event; render it indented for the details overlay.
export function prettyPrintLogRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function wrapLogMessage(message: string, width: number): string[] {
  const max = Math.max(1, width);
  const paragraphs = stripAnsi(message).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= max) {
      lines.push(paragraph);
    } else {
      lines.push(...wrapParagraph(paragraph, max));
    }
  }
  return lines.length > 0 ? lines : [""];
}

export function foldLogLines(lines: readonly string[], width: number, expanded: boolean): LogFold {
  const wrapped = lines.length > 0 ? [...lines] : [""];
  if (expanded || wrapped.length <= 1) {
    return { visible: wrapped, mark: "", folded: false, hidden: 0 };
  }
  const hidden = wrapped.length - 1;
  const mark = ` ${LOG_FOLD_MARK}${hidden}`;
  const room = Math.max(1, width - mark.length);
  return { visible: [clipText(wrapped[0] ?? "", room)], mark, folded: true, hidden };
}

export function logRowExpanded(mode: LogWrapMode, selected: boolean): boolean {
  return mode === "all" || (mode === "focus" && selected);
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

export type LogViewWindow = {
  readonly start: number;
  readonly items: LogEvent[];
  readonly newer: number;
};

export function logViewWindow(events: LogEvent[], pinned: boolean, pinStart: number, tail = LOG_LIST_TAIL): LogViewWindow {
  if (events.length === 0) {
    return { start: 0, items: [], newer: 0 };
  }
  if (!pinned) {
    const start = Math.max(0, events.length - tail);
    return { start, items: events.slice(start), newer: 0 };
  }
  const last = events.length - 1;
  const start = Math.max(0, Math.min(pinStart, last));
  const items = events.slice(start, start + tail);
  return { start, items, newer: Math.max(0, events.length - start - items.length) };
}

export function logPinStart(total: number, tail = LOG_LIST_TAIL): number {
  return Math.max(0, total - tail);
}

export function logCursorStep(
  next: number,
  listCount: number,
  windowStart: number,
  newer: number,
): { selected: number; startDelta: number } {
  const last = Math.max(listCount - 1, 0);
  if (next < 0 && windowStart > 0) {
    const delta = Math.max(-windowStart, next);
    return { selected: 0, startDelta: delta };
  }
  if (next > last && newer > 0) {
    return { selected: last, startDelta: Math.min(newer, next - last) };
  }
  return { selected: Math.min(last, Math.max(0, next)), startDelta: 0 };
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

function wrapParagraph(text: string, width: number): string[] {
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const window = rest.slice(0, width);
    const at = wrapBreakAt(window);
    if (at > 0) {
      lines.push(rest.slice(0, at).trimEnd());
      rest = rest.slice(at).trimStart();
    } else {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
  }
  if (rest.length > 0) {
    lines.push(rest);
  }
  return lines;
}

function wrapBreakAt(window: string): number {
  const space = window.lastIndexOf(" ");
  const tab = window.lastIndexOf("\t");
  const comma = window.lastIndexOf(",");
  const at = Math.max(space, tab, comma);
  if (at < Math.floor(window.length * LOG_WRAP_BIAS)) {
    return -1;
  }
  return window[at] === "," ? at + 1 : at;
}

export function logMessageSpans(message: string): LogSpan[] {
  const plain = stripAnsi(message);
  const spans: LogSpan[] = [];
  const re = new RegExp(LOG_TOKEN.source, "gi");
  let last = 0;
  let match = re.exec(plain);
  while (match) {
    const token = match[0] ?? "";
    if (match.index > last) {
      spans.push({ text: plain.slice(last, match.index), kind: "text" });
    }
    spans.push({ text: token, kind: logSpanKind(token) });
    last = match.index + token.length;
    match = re.exec(plain);
  }
  if (last < plain.length) {
    spans.push({ text: plain.slice(last), kind: "text" });
  }
  if (spans.length === 0) {
    return [{ text: plain, kind: "text" }];
  }
  return spans;
}

export function logMessageWidth(opts: {
  width: number;
  serviceWidth: number;
  showTimestamps: boolean;
  showMeta: boolean;
}): number {
  const time = opts.showTimestamps ? LOG_TIME_COL : 0;
  const meta = opts.showMeta ? LOG_META_COL : 0;
  return Math.max(
    LOG_MSG_MIN,
    opts.width - time - opts.serviceWidth - LOG_LEVEL_COL - meta - LOG_ROW_GUTTER - LOG_COL_GAP * LOG_GAPS,
  );
}

export function logServiceColumnWidth(paneWidth: number, names: string[]): number {
  const longest = names.reduce((max, name) => Math.max(max, name.length), 0);
  const reserved = LOG_TIME_COL + LOG_LEVEL_COL + LOG_ROW_GUTTER + LOG_MSG_MIN + LOG_COL_GAP * LOG_GAPS;
  const available = Math.max(LOG_SERVICE_MIN, paneWidth - reserved);
  const wanted = Math.max(LOG_SERVICE_MIN, longest);
  return Math.min(SERVICE_NAME_MAX, available, wanted);
}

const SYSTEM_LOG_SOURCES = new Set(["auth", "devctl", "proxy"]);

// These are virtual services emitted by the supervisor rather than entries
// in cfg.services. Keep them in the filter catalog even before (or after) a
// bounded log page happens to contain one of their events.
export const INTERNAL_LOG_SERVICES = ["devctl", "mcp", "auth"] as const;

export function isSystemLogSource(source: string): boolean {
  return SYSTEM_LOG_SOURCES.has(source);
}

// Log history is a per-process in-memory buffer (never re-populated from disk on launch), so there
// is no stale cross-session data to protect against here — only `since` (the log-view boundary set
// by an explicit clear or filter command) should ever hide events. Starting or stopping services
// must not clear the view; see the `clear` command / Clear button for that.
export function visibleLogs(events: LogEvent[], since?: string): LogEvent[] {
  return since ? events.filter((ev) => ev.timestamp >= since) : events;
}

export function appendVisibleLogs(current: LogEvent[], incoming: LogEvent[], since: string, cap: number): LogEvent[] {
  const accepted = since === "" ? incoming : incoming.filter((event) => event.timestamp >= since);
  if (accepted.length === 0) {
    return current;
  }
  const limit = Math.max(1, cap);
  if (accepted.length >= limit) {
    return accepted.slice(-limit);
  }
  const drop = Math.max(0, current.length + accepted.length - limit);
  return current.slice(drop).concat(accepted);
}

// Reconciles a freshly loaded bounded page with whatever was already held
// client-side: the page is authoritative for every event at or before its
// own tail sequence, so only already-held events strictly newer than that
// (arrived live while the page request was in flight) are kept alongside
// it — never both, which is what would show a duplicate.
export function mergeLoadedPage(current: LogEvent[], page: LogEvent[]): LogEvent[] {
  const tailSeq = page.length > 0 ? page[page.length - 1]!.seq : -1;
  const newer = current.filter((ev) => ev.seq > tailSeq);
  return [...page, ...newer];
}

// Prepends a page fetched by scrolling back past the currently loaded
// window. De-duplicates by seq in case the two pages touch at the boundary.
export function prependOlderPage(current: LogEvent[], older: LogEvent[]): LogEvent[] {
  if (older.length === 0) {
    return current;
  }
  const known = new Set(current.map((ev) => ev.seq));
  const fresh = older.filter((ev) => !known.has(ev.seq));
  return fresh.length === 0 ? current : [...fresh, ...current];
}

// True exactly when the user has scrolled to the very top of the currently
// loaded window and the server has more (older) history for the active
// filter — the signal to fetch another page rather than paginating further
// within what's already loaded.
export function needsOlderLogPage(pinned: boolean, windowStart: number, hasPrev: boolean): boolean {
  return pinned && windowStart <= 0 && hasPrev;
}

export function visibleLogErrorCount(events: readonly LogEvent[]): number {
  return events.filter((event) => event.level === "ERROR" || event.level === "FATAL").length;
}

export function formatLogLine(ev: LogEvent): string {
  return `${ev.timestamp} ${ev.service} ${ev.level} ${stripAnsi(ev.message)}`;
}

export function formatLogDetails(ev: LogEvent): string {
  return [
    stripAnsi(ev.message),
    `time      ${ev.timestamp}`,
    `service   ${ev.service}`,
    `source    ${ev.source}${ev.stream ? ` / ${ev.stream}` : ""}`,
    `level     ${ev.level}`,
    `pid       ${ev.pid || "—"}`,
    `request   ${ev.request_id || "—"}`,
    `identity  ${ev.identity || "—"}`,
  ].join("\n");
}

export function formatLogsForClipboard(events: LogEvent[]): string {
  return events.map((ev) => formatLogLine(ev)).join("\n");
}

export function filterLogs(
  events: LogEvent[],
  opts: {
    service?: string;
    services?: string[];
    errorOnly?: boolean;
    search?: string;
    regex?: boolean;
    source?: string;
    since?: string;
    until?: string;
    systemLogs?: boolean;
  },
): LogEvent[] {
  const services = opts.services?.filter((name) => name !== "") ?? [];
  const service = opts.service ?? "";
  const search = (opts.search ?? "").trim();
  const source = opts.source ?? "";
  const since = opts.since ?? "";
  const until = opts.until ?? "";
  let matcher: ((text: string) => boolean) | undefined;
  if (search !== "") {
    if (opts.regex === true) {
      const re = compileLogSearch(search);
      if (re) {
        matcher = (text) => re.test(text);
      } else {
        matcher = (text) => text.toLowerCase().includes(search.toLowerCase());
      }
    } else {
      const needle = search.toLowerCase();
      matcher = (text) => text.toLowerCase().includes(needle);
    }
  }
  return events.filter((ev) => {
    if (services.length > 0 && !services.includes(ev.service)) {
      return false;
    }
    if (service !== "" && ev.service !== service) {
      return false;
    }
    if (source !== "" && ev.source !== source) {
      return false;
    }
    if (opts.systemLogs === false && isSystemLogSource(ev.source)) {
      return false;
    }
    if (since !== "" && ev.timestamp < since) {
      return false;
    }
    if (until !== "" && ev.timestamp > until) {
      return false;
    }
    if (opts.errorOnly === true && ev.level !== "ERROR" && ev.level !== "FATAL") {
      return false;
    }
    if (!matcher) {
      return true;
    }
    return matcher(ev.message) || matcher(ev.service);
  });
}

export function logServiceCounts(events: Array<{ service: string }>, names: string[]): { name: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const ev of events) {
    counts[ev.service] = (counts[ev.service] ?? 0) + 1;
  }
  const known = names.map((name) => ({ name, count: counts[name] ?? 0 }));
  const extra = Object.keys(counts)
    .filter((name) => !names.includes(name))
    .sort()
    .map((name) => ({ name, count: counts[name] ?? 0 }));
  return [...known, ...extra];
}

export function logFilterCatalog(
  names: string[],
  events: Array<{ service: string }>,
  extra: string[] = [],
): { name: string; count: number }[] {
  const sources = logFilterSources(names, events, extra);
  return [{ name: "", count: events.length }, ...logServiceCounts(events, sources)];
}

// Adapts server-computed per-service facet counts into the same shape
// logServiceCounts() produces from a client-side buffer, so a facets-based
// caller and a client-buffer-based one can share the same rendering code.
export function facetServiceCounts(names: string[], byService: Record<string, number>): { name: string; count: number }[] {
  const known = names.map((name) => ({ name, count: byService[name] ?? 0 }));
  const extra = Object.keys(byService)
    .filter((name) => !names.includes(name))
    .sort()
    .map((name) => ({ name, count: byService[name] ?? 0 }));
  return [...known, ...extra];
}

// Facets-based counterpart to logFilterCatalog() — same shape, but counts
// come from the server's true totals for the active filter instead of
// whatever page of events happens to be loaded client-side.
export function facetFilterCatalog(
  names: string[],
  facets: LogFacets,
  extra: string[] = [],
): { name: string; count: number }[] {
  const pseudoEvents = Object.keys(facets.byService).map((service) => ({ service }));
  const sources = logFilterSources(names, pseudoEvents, extra);
  return [{ name: "", count: facets.total }, ...facetServiceCounts(sources, facets.byService)];
}

export function runningLabel(running: number, total: number): string {
  if (running <= 0) {
    return "none started";
  }
  return `${running}/${total} running`;
}

export function logFilterSources(names: string[], events: Array<{ service: string }>, extra: string[] = []): string[] {
  const sources = [...names];
  const add = (name: string): void => {
    if (name !== "" && !sources.includes(name)) {
      sources.push(name);
    }
  };
  for (const name of extra) {
    add(name);
  }
  for (const ev of events) {
    add(ev.service);
  }
  return sources;
}

export function pickLogService(names: string[], events: Array<{ service: string }>, slot: number): string | undefined {
  const options = ["", ...logFilterSources(names, events)];
  if (slot < 1 || slot > options.length) {
    return undefined;
  }
  return options[slot - 1];
}

export function cycleLogService(names: string[], current: string, dir: 1 | -1): string {
  const options = ["", ...names];
  const found = options.indexOf(current);
  const start = found < 0 ? 0 : found;
  const next = (start + dir + options.length) % options.length;
  return options[next] ?? "";
}
