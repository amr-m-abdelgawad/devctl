import { type DevctlConfig, type ServiceConfig } from "../config/index.ts";
import { type LogEvent } from "../logs.ts";
import { Detector } from "../secrets.ts";
import { displayState, type Plan, type Runtime } from "../services.ts";
import { type StatusSnapshot } from "../types.ts";
import { allCommands, type CommandSpec } from "./commands.ts";
import { defaultCopyKeybind } from "./tui-config.ts";
import { type ConfirmDetail, type ConfirmKind, type FooterHint, type LifecycleKind, type NavItem, type Overlay, type Screen } from "./types.ts";

export const NARROW_WIDTH = 100;
export const SERVICE_ROW_LEAD = 8;
export const SERVICE_STATE_COL = 12;
export const SERVICE_HEALTH_COL = 10;
export const SERVICE_PORT_COL = 8;
export const SERVICE_PID_COL = 8;
export const SERVICE_NAME_MIN = 12;
export const SERVICE_NAME_MAX = 40;
export const SERVICE_COL_GAP = 2;
export const SERVICE_NAME_PAD = 2;
export const SERVICE_PANE_BORDER = 2;
export const SERVICE_PANE_PAD = 2;
export const SERVICE_LIST_MIN = 34;
const SHOW_HEALTH_AT = 48;
const SHOW_PORT_AT = 60;
const SHOW_PID_AT = 72;
const LIST_PANE_SHARE = 0.48;
export const HEADER_STACK_WIDTH = 90;
export const COMPACT_CHROME_HEIGHT = 20;
const CHROME_HEADER = 1;
const CHROME_NAV = 1;
const CHROME_COMMAND = 1;
const CHROME_STATUS = 1;
const CHROME_RULE = 1;
export function chromeReserved(termW: number, toolbarRules = true): number {
  const headerRows = termW < HEADER_STACK_WIDTH ? CHROME_HEADER + 1 : CHROME_HEADER;
  const rule = toolbarRules ? CHROME_RULE : 0;
  return headerRows + rule + CHROME_NAV + rule + CHROME_COMMAND + rule + CHROME_STATUS + rule;
}
export const CHROME_RESERVED = chromeReserved(HEADER_STACK_WIDTH - 1);
export const TAB_CHIP_PAD = 2;
export const TAB_OVERFLOW_MARK_WIDTH = 2;
const COMPACT_NAV_WIDTH = 80;
const VERY_COMPACT_NAV_WIDTH = 56;

export function tabChipWidth(label: string): number {
  return label.length + TAB_CHIP_PAD;
}

export function navTabLabel(label: string, width: number): string {
  if (width < VERY_COMPACT_NAV_WIDTH) {
    return clipText(label, 3);
  }
  if (width < COMPACT_NAV_WIDTH) {
    return clipText(label, 4);
  }
  return label;
}

export type TabRange = {
  start: number;
  end: number;
};

export function visibleTabRange(widths: number[], activeIndex: number, budget: number): TabRange {
  const count = widths.length;
  if (count === 0 || budget <= 0) {
    return { start: 0, end: -1 };
  }
  const focus = activeIndex >= 0 && activeIndex < count ? activeIndex : 0;
  const unconstrained = growTabRange(widths, focus, budget);
  if (unconstrained.start === 0 && unconstrained.end === count - 1) {
    return unconstrained;
  }
  const leftMark = focus > 0 ? TAB_OVERFLOW_MARK_WIDTH : 0;
  const rightMark = focus < count - 1 ? TAB_OVERFLOW_MARK_WIDTH : 0;
  const reserved = leftMark + rightMark;
  const range = growTabRange(widths, focus, Math.max(widths[focus] ?? 0, budget - reserved));
  const reclaim =
    (leftMark > 0 && range.start === 0 ? TAB_OVERFLOW_MARK_WIDTH : 0) +
    (rightMark > 0 && range.end === count - 1 ? TAB_OVERFLOW_MARK_WIDTH : 0);
  if (reclaim === 0) {
    return range;
  }
  return growTabRange(widths, focus, Math.max(widths[focus] ?? 0, budget - reserved + reclaim));
}

function growTabRange(widths: number[], focus: number, budget: number): TabRange {
  const count = widths.length;
  let start = focus;
  let end = focus;
  let used = widths[focus] ?? 0;
  if (used >= budget) {
    return { start: focus, end: focus };
  }
  while (start > 0 || end < count - 1) {
    const addLeft = start > 0 ? (widths[start - 1] ?? 0) : Number.POSITIVE_INFINITY;
    const addRight = end < count - 1 ? (widths[end + 1] ?? 0) : Number.POSITIVE_INFINITY;
    const leftFits = start > 0 && used + addLeft <= budget;
    const rightFits = end < count - 1 && used + addRight <= budget;
    if (!leftFits && !rightFits) {
      break;
    }
    const leftDistance = focus - (start - 1);
    const rightDistance = end + 1 - focus;
    if (leftFits && (!rightFits || leftDistance <= rightDistance)) {
      start -= 1;
      used += addLeft;
    } else if (rightFits) {
      end += 1;
      used += addRight;
    } else {
      break;
    }
  }
  return { start, end };
}

export function navActiveIndex(screen: Screen): number {
  if (screen === "detail") {
    return NAV_ITEMS.findIndex((item) => item.id === "services");
  }
  return NAV_ITEMS.findIndex((item) => item.id === screen);
}

export function clipText(value: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (value.length <= max) {
    return value;
  }
  if (max === 1) {
    return "…";
  }
  return `${value.slice(0, max - 1)}…`;
}

export function serviceRowShowsHealth(paneWidth: number): boolean {
  return paneWidth >= SHOW_HEALTH_AT;
}

export function serviceRowShowsPort(paneWidth: number): boolean {
  return paneWidth >= SHOW_PORT_AT;
}

export function serviceRowShowsPid(paneWidth: number): boolean {
  return paneWidth >= SHOW_PID_AT;
}

export function serviceListInnerWidth(paneWidth: number, pad = 0): number {
  return Math.max(1, paneWidth - SERVICE_PANE_BORDER - pad * 2);
}

export function serviceNameColumnWidth(paneWidth: number): number {
  let used = SERVICE_ROW_LEAD + SERVICE_STATE_COL + SERVICE_COL_GAP;
  if (serviceRowShowsHealth(paneWidth)) {
    used += SERVICE_HEALTH_COL;
  }
  if (serviceRowShowsPort(paneWidth)) {
    used += SERVICE_PORT_COL;
  }
  if (serviceRowShowsPid(paneWidth)) {
    used += SERVICE_PID_COL;
  }
  return Math.max(SERVICE_NAME_MIN, paneWidth - used);
}

export const LOG_TIME_COL = 9;
export const LOG_LEVEL_COL = 7;
export const LOG_SERVICE_MIN = 10;
export const LOG_MSG_MIN = 16;
export const LOG_ROW_GUTTER = 2;
export const LOG_COL_GAP = 1;
export const LOG_LIST_TAIL = 200;
export const LOG_FOLD_MARK = "▸";
const LOG_GAPS = 2;
const LOG_WRAP_BIAS = 0.4;

export type LogWrapMode = "clip" | "focus" | "all";

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

export function wrapLogMessage(message: string, width: number): string[] {
  const max = Math.max(1, width);
  const paragraphs = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
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
    return { selected: 0, startDelta: -1 };
  }
  if (next > last && newer > 0) {
    return { selected: last, startDelta: 1 };
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
  const spans: LogSpan[] = [];
  const re = new RegExp(LOG_TOKEN.source, "gi");
  let last = 0;
  let match = re.exec(message);
  while (match) {
    const token = match[0] ?? "";
    if (match.index > last) {
      spans.push({ text: message.slice(last, match.index), kind: "text" });
    }
    spans.push({ text: token, kind: logSpanKind(token) });
    last = match.index + token.length;
    match = re.exec(message);
  }
  if (last < message.length) {
    spans.push({ text: message.slice(last), kind: "text" });
  }
  if (spans.length === 0) {
    return [{ text: message, kind: "text" }];
  }
  return spans;
}

export function logServiceColumnWidth(paneWidth: number, names: string[]): number {
  const longest = names.reduce((max, name) => Math.max(max, name.length), 0);
  const reserved = LOG_TIME_COL + LOG_LEVEL_COL + LOG_ROW_GUTTER + LOG_MSG_MIN + LOG_COL_GAP * LOG_GAPS;
  const available = Math.max(LOG_SERVICE_MIN, paneWidth - reserved);
  const wanted = Math.max(LOG_SERVICE_MIN, longest);
  return Math.min(SERVICE_NAME_MAX, available, wanted);
}

export function serviceListPaneWidth(termWidth: number, names: string[], stacked: boolean): number {
  if (stacked) {
    return termWidth;
  }
  const longest = names.reduce((max, name) => Math.max(max, name.length), 0);
  const nameCol = Math.min(SERVICE_NAME_MAX, Math.max(SERVICE_NAME_MIN, longest + SERVICE_NAME_PAD));
  const wanted =
    SERVICE_ROW_LEAD + SERVICE_STATE_COL + SERVICE_COL_GAP + nameCol + SERVICE_PANE_BORDER + SERVICE_PANE_PAD;
  const cap = Math.max(SERVICE_LIST_MIN, Math.floor(termWidth * LIST_PANE_SHARE));
  return Math.min(cap, Math.max(SERVICE_LIST_MIN, wanted));
}

export function padClip(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (value.length >= width) {
    return clipText(value, width);
  }
  return value.padEnd(width);
}

export function visibleHints(hints: FooterHint[], width: number): FooterHint[] {
  const out: FooterHint[] = [];
  let used = 0;
  for (const hint of hints) {
    const cost = hint.key.length + hint.label.length + 3;
    if (used + cost > width) {
      break;
    }
    out.push(hint);
    used += cost;
  }
  return out;
}

export type OverlayRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function compactChrome(termH: number): boolean {
  return termH < COMPACT_CHROME_HEIGHT;
}

export function overlayRect(
  termW: number,
  termH: number,
  preferW: number,
  preferH: number,
  anchor: "center" | "bottom" = "center",
  toolbarRules = true,
): OverlayRect {
  const width = Math.min(preferW, Math.max(1, termW - 4));
  const chrome = Math.min(chromeReserved(termW, toolbarRules), Math.max(0, termH - 1));
  const height = Math.min(preferH, Math.max(1, termH - chrome));
  const left = Math.max(0, Math.min(Math.floor((termW - width) / 2), Math.max(0, termW - width)));
  const rawTop = anchor === "bottom" ? termH - 2 - height : Math.floor((termH - height) / 2);
  const top = Math.max(0, Math.min(rawTop, termH - height));
  return { left, top, width, height };
}

export type StatusTone = "success" | "warning" | "error" | "info" | "idle";

const SUCCESS_STATUS = /^(started|stopped|restarted|refreshed|cleared|copied|exported|jumped|proxy started|proxy stopped|secrets|re-running|theme |mouse |leader |display |restored)/i;
const ERROR_STATUS = /\b(fail|error|unknown|not found|no configuration|blocked|already in use|is using port)\b/i;

export function statusChipTone(status: string): StatusTone {
  if (status === "") {
    return "idle";
  }
  if (ERROR_STATUS.test(status)) {
    return "error";
  }
  if (status.includes("session only")) {
    return "warning";
  }
  if (SUCCESS_STATUS.test(status)) {
    return "success";
  }
  return "info";
}

export function planServices(
  cfg: DevctlConfig,
  targets: string[],
  profileName: string,
): { services: string[]; profile: string } {
  const profile = profileName !== "" && cfg.profiles[profileName] ? profileName : "";
  if (targets.length > 0) {
    return { services: targets, profile };
  }
  if (profile !== "") {
    return { services: [...(cfg.profiles[profileName]?.services ?? [])], profile };
  }
  return { services: Object.keys(cfg.services), profile: "" };
}

export const MCP_FOCUS_COUNT = 6;

export function screenListCount(
  screen: Screen,
  counts: { doctor: number; settings: number; profiles: number; services: number; logs?: number; mcp?: number },
): number {
  if (screen === "doctor") {
    return counts.doctor;
  }
  if (screen === "settings") {
    return counts.settings;
  }
  if (screen === "profiles") {
    return counts.profiles;
  }
  if (screen === "dashboard" || screen === "services") {
    return counts.services;
  }
  if (screen === "logs") {
    return counts.logs ?? 0;
  }
  if (screen === "mcp") {
    return counts.mcp ?? MCP_FOCUS_COUNT;
  }
  return 0;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "dashboard" },
  { id: "services", label: "services" },
  { id: "logs", label: "logs" },
  { id: "auth", label: "identity" },
  { id: "credentials", label: "credentials" },
  { id: "proxy", label: "proxy" },
  { id: "doctor", label: "doctor" },
  { id: "config", label: "config" },
  { id: "profiles", label: "profiles" },
  { id: "setup", label: "setup" },
  { id: "settings", label: "settings" },
];

export function navItemForDigit(name: string): Screen | undefined {
  if (name === "0") {
    return NAV_ITEMS[9]?.id;
  }
  if (name.length === 1 && name >= "1" && name <= "9") {
    return NAV_ITEMS[Number(name) - 1]?.id;
  }
  return undefined;
}

const NAV_CYCLE: Screen[] = NAV_ITEMS.map((item) => item.id);

export function defaultProfileName(cfg?: DevctlConfig): string {
  if (!cfg) {
    return "";
  }
  const names = Object.keys(cfg.profiles).sort();
  return names[0] ?? "";
}

export function isActiveRuntime(rt?: Runtime): boolean {
  if (!rt) {
    return false;
  }
  return rt.state === "RUNNING" || rt.state === "STARTING" || rt.state === "RESTARTING" || rt.health === "HEALTHY";
}

export function countRunning(snap?: StatusSnapshot): { running: number; total: number } {
  const services = snap?.services ?? {};
  const total = Object.keys(services).length;
  const running = Object.values(services).filter((rt) => isActiveRuntime(rt)).length;
  return { running, total };
}

export function noneStarted(snap?: StatusSnapshot): boolean {
  if (!snap) {
    return true;
  }
  const runtimes = Object.values(snap.services);
  if (runtimes.length === 0) {
    return true;
  }
  return runtimes.every((rt) => rt.state === "STOPPED" || rt.state === "UNKNOWN");
}

export function canStartAll(snap?: StatusSnapshot): boolean {
  if (!snap) {
    return true;
  }
  const runtimes = Object.values(snap.services);
  if (runtimes.length === 0) {
    return true;
  }
  return !runtimes.some((rt) => isActiveRuntime(rt));
}

export function explicitServices(args: string[], checked: string[]): string[] {
  if (args.length > 0) {
    return args;
  }
  return [...checked];
}

export function focusedServices(checked: string[], focused: string): string[] {
  if (checked.length > 0) {
    return [...checked];
  }
  return focused === "" ? [] : [focused];
}

export function visibleLogs(events: LogEvent[], snap?: StatusSnapshot, since?: string): LogEvent[] {
  if (noneStarted(snap)) {
    return [];
  }
  if (!since) {
    return events;
  }
  return events.filter((ev) => ev.timestamp >= since);
}

export function formatLogLine(ev: LogEvent): string {
  return `${ev.timestamp} ${ev.service} ${ev.level} ${ev.message}`;
}

export function formatLogDetails(ev: LogEvent): string {
  return [
    ev.message,
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
  opts: { service?: string; services?: string[]; errorOnly?: boolean; search?: string; regex?: boolean; source?: string; since?: string },
): LogEvent[] {
  const services = opts.services?.filter((name) => name !== "") ?? [];
  const service = opts.service ?? "";
  const search = (opts.search ?? "").trim();
  const source = opts.source ?? "";
  const since = opts.since ?? "";
  let matcher: ((text: string) => boolean) | undefined;
  if (search !== "") {
    if (opts.regex === true) {
      try {
        const re = new RegExp(search);
        matcher = (text) => re.test(text);
      } catch {
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
    if (since !== "" && ev.timestamp < since) {
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

export function alreadyUpNames(plan: Plan, snap?: StatusSnapshot): string[] {
  return plan.waves.flat().filter((name) => isActiveRuntime(snap?.services[name]));
}

export function pendingPlanWaves(plan: Plan, snap?: StatusSnapshot): string[][] {
  return plan.waves
    .map((wave) => wave.filter((name) => !isActiveRuntime(snap?.services[name])))
    .filter((wave) => wave.length > 0);
}

export function formatPlanSummary(plan: Plan): string {
  return plan.waves.flat().join(" → ");
}

export function formatStarted(plan: Plan): string {
  const summary = formatPlanSummary(plan);
  if (summary === "") {
    return "Started selected services";
  }
  return `Started ${summary}`;
}

export function formatStopped(plan: Plan): string {
  const summary = formatPlanSummary(plan);
  if (summary === "") {
    return "Stopped running services";
  }
  return `Stopped ${summary}`;
}

export function planHeadline(plan: Plan, busy: boolean, failed: string, kind: LifecycleKind = "start"): string {
  const verb = kind === "stop" ? "Stop" : kind === "restart" ? "Restart" : "Start";
  if (failed) {
    return `${verb} failed on ${failed}`;
  }
  if (busy) {
    if (kind === "stop") {
      return "Stopping services";
    }
    if (kind === "restart") {
      return plan.profile ? `Restarting profile ${plan.profile}` : "Restarting selected services";
    }
    return plan.profile ? `Starting profile ${plan.profile}` : "Starting selected services";
  }
  if (kind === "stop") {
    return "Stopped";
  }
  if (kind === "restart") {
    return plan.profile ? `Restarted profile ${plan.profile}` : "Restart finished";
  }
  return plan.profile ? `Started profile ${plan.profile}` : "Start finished";
}

export function planRowNote(name: string, plan: Plan, snap?: StatusSnapshot, kind: LifecycleKind = "start"): string {
  const rt = snap?.services[name];
  const state = serviceLineState(rt);
  if (rt?.last_error && kind !== "stop") {
    return rt.last_error;
  }
  if (kind === "stop") {
    if (state === "STOPPED") {
      return "stopped";
    }
    if (state === "STOPPING") {
      return "stopping now";
    }
    if (state === "FAILED") {
      return "already failed";
    }
    return "queued";
  }
  if (state === "HEALTHY") {
    return "ready";
  }
  if (state === "STARTING") {
    return "starting now";
  }
  if (state === "RUNNING") {
    return "up, waiting for health";
  }
  if (state === "STOPPING") {
    return "stopping first";
  }
  if (state === "FAILED") {
    return "failed — later waves will not start";
  }
  const step = plan.steps.find((s) => s.name === name);
  const pending = (step?.dependencies ?? []).filter((dep) => {
    const depState = serviceLineState(snap?.services[dep]);
    return depState !== "HEALTHY";
  });
  if (pending.length > 0) {
    return `waits for ${pending.join(", ")}`;
  }
  return "queued";
}

export function planNextAction(busy: boolean, failed: string, kind: LifecycleKind = "start"): string {
  if (busy) {
    if (kind === "stop") {
      return "Stopping dependents first.  esc  hide this panel";
    }
    if (kind === "restart") {
      return "Stop first, then start in order.  esc  hide this panel";
    }
    return "Later waves wait until this wave is healthy.  esc  hide this panel";
  }
  if (failed) {
    const retry = kind === "stop" ? "try /stop again" : "/start again";
    return `Fix ${failed}, then ${retry}.  enter or esc  back to dashboard`;
  }
  return "Finished.  enter or esc  back to dashboard";
}

export function nextScreen(current: Screen): Screen {
  const idx = NAV_CYCLE.indexOf(current);
  if (idx < 0) {
    return "dashboard";
  }
  return NAV_CYCLE[(idx + 1) % NAV_CYCLE.length] ?? "dashboard";
}

export function prevScreen(current: Screen): Screen {
  const idx = NAV_CYCLE.indexOf(current);
  if (idx < 0) {
    return "dashboard";
  }
  return NAV_CYCLE[(idx - 1 + NAV_CYCLE.length) % NAV_CYCLE.length] ?? "dashboard";
}

export function groupedCommands(commands: CommandSpec[]): { group: string; items: CommandSpec[] }[] {
  const order = ["services", "nav", "logs", "ui", "app"];
  return order.flatMap((group) => {
    const items = commands.filter((c) => c.group === group);
    if (items.length === 0) {
      return [];
    }
    return [{ group, items }];
  });
}

export function paletteOptions(query: string): CommandSpec[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  const matches = allCommands().filter((c) => q === "" || c.name.includes(q) || c.desc.toLowerCase().includes(q) || c.aliases.some((a) => a.startsWith(q)));
  return groupedCommands(matches).flatMap((group) => group.items);
}

export function commandSelectOptions(items: CommandSpec[]): { name: string; description: string; value: string }[] {
  return groupedCommands(items).flatMap((group) =>
    group.items.map((cmd) => ({
      name: `/${cmd.name}`,
      description: `${group.group} · ${cmd.desc}`,
      value: cmd.name,
    })),
  );
}

export function footerHints(screen: Screen, overlay: Overlay, copyKey = defaultCopyKeybind()): FooterHint[] {
  if (overlay === "slash") {
    return [
      { key: "↑↓", label: "suggest" },
      { key: "tab", label: "complete" },
      { key: "enter", label: "run" },
      { key: "esc", label: "cancel" },
    ];
  }
  if (overlay === "palette" || overlay === "themes") {
    return [
      { key: "↑↓", label: "move" },
      { key: "enter", label: overlay === "themes" ? "save" : "select" },
      { key: "esc", label: overlay === "themes" ? "revert" : "close" },
    ];
  }
  if (overlay === "help") {
    return [
      { key: "j/k", label: "scroll" },
      { key: "esc", label: "close" },
    ];
  }
  if (overlay === "log-details") {
    return [
      { key: copyKey, label: "copy" },
      { key: "esc", label: "close" },
    ];
  }
  if (overlay === "confirm") {
    return [
      { key: "enter", label: "confirm" },
      { key: "esc", label: "stay" },
    ];
  }
  if (overlay === "plan") {
    return [
      { key: "esc", label: "back to dashboard" },
      { key: "enter", label: "done" },
    ];
  }
  if (overlay === "leader") {
    return leaderHints();
  }
  return screenHints(screen, copyKey);
}

export function leaderHints(): FooterHint[] {
  return [
    { key: "n", label: "start" },
    { key: "x", label: "stop" },
    { key: "R", label: "restart" },
    { key: "s", label: "services" },
    { key: "l", label: "logs" },
    { key: "t", label: "themes" },
    { key: "q", label: "quit" },
  ];
}

function screenHints(screen: Screen, copyKey: string): FooterHint[] {
  const common: FooterHint[] = [
    { key: "/", label: "command" },
    { key: "ctrl+p", label: "palette" },
    { key: "?", label: "help" },
  ];
  switch (screen) {
    case "dashboard":
      return [
        { key: "space", label: "select" },
        { key: "enter", label: "start or open" },
        { key: "n", label: "start" },
        { key: "x", label: "stop" },
        { key: "r", label: "refresh" },
        { key: "R", label: "restart" },
        { key: "←→", label: "log filter" },
        { key: "g", label: "latest" },
        { key: "z", label: "full logs" },
        { key: copyKey, label: "copy logs" },
        { key: "j/k", label: "move" },
        ...common,
      ];
    case "services":
      return [
        { key: "enter", label: "detail" },
        { key: "space", label: "select" },
        { key: "n", label: "start" },
        { key: "x", label: "stop" },
        { key: "r", label: "refresh" },
        { key: "R", label: "restart" },
        ...common,
      ];
    case "detail":
      return [{ key: "n", label: "start" }, { key: "x", label: "stop" }, { key: "o", label: "config" }, { key: "l", label: "logs" }, { key: "esc", label: "back" }, ...common];
    case "logs":
      return [
        { key: "←→", label: "filter" },
        { key: "1-9", label: "source" },
        { key: "e", label: "errors" },
        { key: "g", label: "latest" },
        { key: "f", label: "search" },
        { key: "t", label: "time" },
        { key: "m", label: "meta" },
        { key: "w", label: "wrap" },
        { key: "j/k", label: "move" },
        { key: copyKey, label: "copy" },
        { key: "p", label: "pause" },
        { key: "z", label: "full screen" },
        { key: "/exports", label: "open folder" },
        ...common,
      ];
    case "profiles":
      return [{ key: "enter", label: "use profile" }, { key: "j/k", label: "move" }, ...common];
    case "proxy":
      return [{ key: "n", label: "start proxy" }, { key: "x", label: "stop proxy" }, ...common];
    case "mcp":
      return [
        { key: "j/k", label: "move" },
        { key: "space", label: "start or copy" },
        { key: "←→", label: "change port" },
        { key: "enter", label: "start or copy" },
        ...common,
      ];
    case "config":
      return [{ key: "e", label: "edit" }, { key: "/reload", label: "reload" }, { key: "j/k", label: "scroll" }, ...common];
    case "setup":
      return [{ key: "esc", label: "dashboard" }, ...common];
    case "doctor":
      return [{ key: "j/k", label: "move" }, { key: "enter", label: "fix port" }, { key: "r", label: "rerun" }, ...common];
    case "settings":
      return [
        { key: "j/k", label: "move" },
        { key: "←→", label: "save" },
        { key: "enter", label: "apply or open page" },
        { key: "space", label: "toggle" },
        ...common,
      ];
    default:
      return [{ key: "tab", label: "screens" }, ...common];
  }
}

export function slashWindowStart(selected: number, size: number, total: number): number {
  if (total <= size || selected < size) {
    return 0;
  }
  return Math.min(selected - size + 1, total - size);
}

export function selectedSlashCommand<T>(items: T[], index: number): T | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const clamped = Math.min(Math.max(index, 0), items.length - 1);
  return items[clamped];
}

export function serviceCommandText(svc: ServiceConfig): string {
  return svc.command.args.join(" ") || "—";
}

export function servicePortsText(svc: ServiceConfig, rt?: Runtime): string {
  const live = firstPort(rt);
  if (live !== "") {
    return live;
  }
  if (svc.ports.length === 0) {
    return "—";
  }
  return svc.ports.map((port) => `${port.name}:${port.auto ? "auto" : port.value}`).join(" ");
}

export function serviceHealthText(svc: ServiceConfig): string {
  const kind = svc.health.type || "none";
  const target = svc.health.url || svc.health.address;
  return target === "" ? kind : `${kind} ${target}`;
}

export function serviceIdentityText(svc: ServiceConfig, rt?: Runtime): string {
  if (rt?.identity) {
    return rt.identity;
  }
  const kind = svc.identity.type || "none";
  const account = svc.identity.service_account;
  return account === "" ? kind : `${kind} ${account}`;
}

export function serviceRestartText(svc: ServiceConfig): string {
  const policy = svc.restart.policy || "none";
  if (svc.restart.max_retries > 0) {
    return `${policy} ×${svc.restart.max_retries}`;
  }
  return policy;
}

export type ServiceEnvEntry = {
  key: string;
  value: string;
  required: boolean;
};

const ENV_KEY_MIN = 10;
const ENV_KEY_MAX = 28;
const ENV_KEY_SHARE = 0.42;
const ENV_PANE_GUTTER = 2;
const ENV_PANE_MIN = 20;

export function serviceEnvEntries(
  svc: ServiceConfig,
  reveal: boolean,
  extraMarkers: string[],
  extraPatterns: string[],
): ServiceEnvEntry[] {
  const merged = { ...svc.environment.defaults, ...svc.environment.vars };
  const redacted = redactEnv(merged, reveal, extraMarkers, extraPatterns);
  const keys = new Set([...Object.keys(redacted), ...svc.environment.required]);
  return [...keys].sort().map((key) => ({
    key,
    value: redacted[key] ?? "",
    required: svc.environment.required.includes(key),
  }));
}

export function envKeyColumnWidth(paneWidth: number): number {
  const inner = Math.max(ENV_PANE_MIN, paneWidth - ENV_PANE_GUTTER);
  return Math.min(ENV_KEY_MAX, Math.max(ENV_KEY_MIN, Math.floor(inner * ENV_KEY_SHARE)));
}

export function firstPort(rt?: Runtime): string {
  if (!rt) {
    return "";
  }
  if (rt.ports.http !== undefined) {
    return String(rt.ports.http);
  }
  const value = Object.values(rt.ports)[0];
  return value !== undefined ? String(value) : "";
}

export function serviceLineState(rt?: Runtime): string {
  if (!rt) {
    return "STOPPED";
  }
  return displayState(rt);
}

export function confirmCopy(kind: ConfirmKind, profile: string, detail?: ConfirmDetail): { title: string; body: string } {
  if (kind === "quit") {
    return {
      title: "Quit",
      body: "Stop managed services and leave the TUI? Press d to detach and leave them running.",
    };
  }
  if (kind === "reload") {
    return {
      title: "Reload applied",
      body: profile === "" ? "Configuration changed. Restart marked services?" : `Restart required: ${profile}`,
    };
  }
  if (kind === "reset-prefs") {
    return {
      title: "Reset preferences",
      body: "Restore theme, display size, mouse, and leader timeout to defaults? This overwrites your saved tui.json values.",
    };
  }
  if (kind === "free-port") {
    const port = detail?.port ?? 0;
    const proc = detail?.process || "process";
    const pid = detail?.pid ?? 0;
    return {
      title: `Free port ${port}`,
      body: `Stop ${proc} (pid ${pid}) so port ${port} can be used? This sends SIGTERM, then SIGKILL if it stays up.`,
    };
  }
  return {
    title: "Start profile",
    body: profile === "" ? "Start the configured services?" : `Start profile ${profile}?`,
  };
}

export function redactEnv(env: Record<string, string>, reveal: boolean, extraMarkers: string[], extraPatterns: string[]): Record<string, string> {
  if (reveal) {
    return env;
  }
  return new Detector(extraMarkers, extraPatterns).redactMap(env);
}

export function profileMembers(cfg: DevctlConfig | undefined, name: string): string {
  if (!cfg) {
    return "";
  }
  return (cfg.profiles[name]?.services ?? []).join(", ");
}
