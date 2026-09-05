import { dependencyCondition, dependencyName, type DevctlConfig, type ServiceConfig } from "../../adapters/config/index.ts";
import { type BusEvent } from "../../shared/events.ts";
import { compileLogSearch, LevelUnknown, type LogEvent, type LogFacets } from "../../adapters/storage/logs.ts";
import { Detector } from "../../adapters/secrets/detector.ts";
import { displayState, type Plan, type Runtime } from "../../domain/service/services.ts";
import { type PersistedState } from "../../adapters/storage/storage.ts";
import { type StatusSnapshot } from "../../types.ts";
import { allCommands, type CommandSpec } from "./commands.ts";
import { defaultCopyKeybind } from "./tui-config.ts";
import { type ConfirmDetail, type ConfirmKind, type FooterHint, type LifecycleKind, type NavItem, type Overlay, type Screen } from "./types.ts";

export const NARROW_WIDTH = 100;
export const SERVICE_ROW_LEAD = 8;
export const SERVICE_STATE_COL = 12;
export const SERVICE_HEALTH_COL = 10;
export const SERVICE_PORT_COL = 8;
export const SERVICE_PID_COL = 8;
export const SERVICE_UPTIME_COL = 9;
export const SERVICE_RESTARTS_COL = 6;
export const SERVICE_CPU_COL = 7;
export const SERVICE_MEM_COL = 8;
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
export const HEADER_NARROW_WIDTH = 60;
export const SETUP_STEP_COUNT = 9;
export const LOG_META_COL = 8;
export const PAGE_SCROLL_MIN = 8;
export const PLAN_OVERLAY_MAX = 22;
export const PLAN_OVERLAY_CHROME = 6;
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

export function pageScrollAmount(termH: number): number {
  return Math.max(PAGE_SCROLL_MIN, termH - PLAN_OVERLAY_CHROME * 2);
}

export function planOverlayHeight(termH: number, contentRows: number): number {
  const cap = Math.min(PLAN_OVERLAY_MAX, Math.max(PAGE_SCROLL_MIN, termH - PLAN_OVERLAY_CHROME));
  return Math.min(cap, Math.max(PAGE_SCROLL_MIN, contentRows));
}

export type HeaderChip = { label: string; tone: "success" | "idle" | "info" | "error" | "warning"; hide?: boolean };

export function headerStatusChips(opts: {
  width: number;
  running: number;
  total: number;
  proxyOn: boolean;
  proxyAddress: string;
  mcpOn: boolean;
  adc: boolean;
  reveal: boolean;
}): HeaderChip[] {
  const narrow = opts.width < HEADER_NARROW_WIDTH;
  const proxyLabel = opts.proxyOn ? `● ${clipText(opts.proxyAddress, narrow ? 10 : 18)}` : narrow ? "" : "○ off";
  return [
    { label: narrow ? `${opts.running}/${opts.total}` : runningLabel(opts.running, opts.total), tone: opts.running > 0 ? "success" : "idle" },
    { label: proxyLabel, tone: opts.proxyOn ? "info" : "idle", hide: narrow && !opts.proxyOn },
    { label: "MCP", tone: "info", hide: !opts.mcpOn },
    { label: opts.adc ? (narrow ? "ADC" : "ADC ok") : narrow ? "!ADC" : "ADC missing", tone: opts.adc ? "success" : "error" },
    { label: narrow ? "sec" : "secrets shown", tone: "warning", hide: !opts.reveal },
  ];
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

// No fallback constant here on purpose: the mcp screen's row count now
// depends on how many tools exist, which only screens/Mcp.tsx knows. A
// hardcoded duplicate would silently go stale the next time a tool is added.

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
    return counts.mcp ?? 0;
  }
  if (screen === "setup") {
    return SETUP_STEP_COUNT;
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
  { id: "stats", label: "stats" },
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

const LIVE_PROCESS_STATES = new Set(["RUNNING", "STARTING", "RESTARTING", "HEALTHY", "UNHEALTHY"]);
const LOAD_WARN_RATIO = 0.85;
const LOAD_DANGER_RATIO = 1.5;
const LEFTOVER_WARN_RATIO = 0.2;
const LEFTOVER_DANGER_RATIO = 0.1;
const TOP_LOG_SOURCES = 5;

export function isLiveProcessState(state: string): boolean {
  return LIVE_PROCESS_STATES.has(state);
}

export function isActiveRuntime(rt?: Runtime): boolean {
  if (!rt) {
    return false;
  }
  return isLiveProcessState(rt.state);
}

export function countRunning(snap?: StatusSnapshot, names?: string[]): { running: number; total: number } {
  const keys = names ?? Object.keys(snap?.services ?? {});
  const running = keys.filter((name) => isActiveRuntime(snap?.services[name])).length;
  return { running, total: keys.length };
}

export type ServiceFleetStats = {
  total: number;
  live: number;
  running: number;
  starting: number;
  healthy: number;
  failed: number;
  stopping: number;
  stopped: number;
};

export function serviceFleetStats(names: string[], snap?: StatusSnapshot): ServiceFleetStats {
  let running = 0;
  let starting = 0;
  let healthy = 0;
  let failed = 0;
  let stopping = 0;
  let stopped = 0;
  for (const name of names) {
    const rt = snap?.services[name];
    if (rt?.health === "HEALTHY") {
      healthy += 1;
    }
    const state = rt?.state ?? "STOPPED";
    if (state === "FAILED") {
      failed += 1;
    } else if (state === "STOPPING") {
      stopping += 1;
    } else if (state === "STARTING" || state === "RESTARTING") {
      starting += 1;
    } else if (isLiveProcessState(state)) {
      running += 1;
    } else {
      stopped += 1;
    }
  }
  return {
    total: names.length,
    live: running + starting,
    running,
    starting,
    healthy,
    failed,
    stopping,
    stopped,
  };
}

export type ResourceTone = "success" | "warning" | "error";

export function loadPerCpu(load: number, cpuCount: number): number {
  if (!Number.isFinite(load) || !Number.isFinite(cpuCount) || cpuCount <= 0) {
    return 0;
  }
  return load / cpuCount;
}

export function memoryUsedKB(totalKB: number, freeKB: number): number {
  if (!Number.isFinite(totalKB) || !Number.isFinite(freeKB) || totalKB < 0 || freeKB < 0) {
    return 0;
  }
  return Math.max(0, Math.min(totalKB, totalKB - freeKB));
}

export function resourceTone(ratio: number, warn: number, danger: number): ResourceTone {
  if (!Number.isFinite(ratio)) {
    return "success";
  }
  if (ratio > danger) {
    return "error";
  }
  if (ratio > warn) {
    return "warning";
  }
  return "success";
}

export function loadTone(load: number, cpuCount: number): ResourceTone {
  return resourceTone(loadPerCpu(load, cpuCount), LOAD_WARN_RATIO, LOAD_DANGER_RATIO);
}

export function leftoverTone(leftoverKB: number, totalKB: number): ResourceTone {
  const ratio = totalKB > 0 ? leftoverKB / totalKB : 1;
  if (ratio < LEFTOVER_DANGER_RATIO) {
    return "error";
  }
  if (ratio < LEFTOVER_WARN_RATIO) {
    return "warning";
  }
  return "success";
}

export function memoryTone(usedKB: number, totalKB: number): ResourceTone {
  return leftoverTone(Math.max(0, totalKB - usedKB), totalKB);
}

export function formatLoadAvg(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "—";
  }
  return value.toFixed(2);
}

export function formatRatioPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) {
    return "—";
  }
  return `${Math.round(ratio * 100)}%`;
}

export function runtimeUptime(rt: Runtime | undefined, now = Date.now()): string {
  if (!rt?.startTime) {
    return "—";
  }
  const start = new Date(rt.startTime).getTime();
  if (!Number.isFinite(start)) {
    return "—";
  }
  return formatUptime(now - start);
}

export function topLogSources(counts: Record<string, number>, limit = TOP_LOG_SOURCES): [string, number][] {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

export type StatsServiceColumns = {
  name: number;
  health: boolean;
  cpu: boolean;
  mem: boolean;
  up: boolean;
  rst: boolean;
  pid: boolean;
};

const STATS_SHOW_HEALTH = 52;
const STATS_SHOW_CPU = 64;
const STATS_SHOW_MEM = 72;
const STATS_SHOW_UP = 82;
const STATS_SHOW_RST = 90;
const STATS_SHOW_PID = 100;
const STATS_FRAME_BORDER = 2;
const STATS_SECTION_BORDER = 2;
const STATS_SECTION_PAD_X = 2;
const STATS_SCROLLBAR = 1;
export const STATS_RESTARTS_COL = 8;
const FACT_WHAT_MIN = 8;
const FACT_WHAT_MAX = 22;
const FACT_READING_MIN = 6;
const FACT_READING_MAX = 28;
const FACT_MEANING_MIN = 12;
export const STATS_FACT_GAP = 2;
export const STATS_RESOURCE_BAR = 10;
export const STATS_METER_COL = 18;

export function statsPaneWidth(termWidth: number, pad = 1): number {
  return Math.max(24, termWidth - STATS_FRAME_BORDER - pad * 2 - STATS_SECTION_BORDER - STATS_SECTION_PAD_X - STATS_SCROLLBAR);
}

export function statsServiceColumns(width: number): StatsServiceColumns {
  const health = width >= STATS_SHOW_HEALTH;
  const cpu = width >= STATS_SHOW_CPU;
  const mem = width >= STATS_SHOW_MEM;
  const up = width >= STATS_SHOW_UP;
  const rst = width >= STATS_SHOW_RST;
  const pid = width >= STATS_SHOW_PID;
  let used = SERVICE_STATE_COL + SERVICE_COL_GAP;
  if (health) {
    used += SERVICE_HEALTH_COL + SERVICE_COL_GAP;
  }
  if (cpu) {
    used += SERVICE_CPU_COL + SERVICE_COL_GAP;
  }
  if (mem) {
    used += SERVICE_MEM_COL + SERVICE_COL_GAP;
  }
  if (up) {
    used += SERVICE_UPTIME_COL + SERVICE_COL_GAP;
  }
  if (rst) {
    used += STATS_RESTARTS_COL + SERVICE_COL_GAP;
  }
  if (pid) {
    used += SERVICE_PID_COL;
  }
  return { name: Math.max(SERVICE_NAME_MIN, width - used), health, cpu, mem, up, rst, pid };
}

export type ResourceMeter = {
  ratio: number;
  label: string;
};

export function resourceMeter(ratio: number): ResourceMeter {
  const safe = Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
  return { ratio: Math.min(1, safe), label: formatRatioPercent(safe) };
}

export function formatResourceMeter(meter: ResourceMeter, barLen = STATS_RESOURCE_BAR): string {
  return `[${renderBar(meter.ratio, barLen)}] ${meter.label.padStart(4)}`;
}

export type StatsFact = {
  what: string;
  reading: string;
  meaning: string;
  tone?: ResourceTone | "muted" | "text";
  meter?: ResourceMeter;
};

export type FactColumns = {
  what: number;
  reading: number;
  meaning: number;
  meter: number;
};

export function factTableColumns(facts: readonly StatsFact[], width: number): FactColumns {
  const whatNeed = facts.reduce((max, fact) => Math.max(max, fact.what.length), "what".length);
  const readNeed = facts.reduce((max, fact) => Math.max(max, fact.reading.length), "reading".length);
  const meter = facts.some((fact) => fact.meter) ? STATS_METER_COL : 0;
  const gaps = STATS_FACT_GAP * (meter > 0 ? 3 : 2);
  let what = Math.min(FACT_WHAT_MAX, Math.max(FACT_WHAT_MIN, whatNeed));
  let reading = Math.min(FACT_READING_MAX, Math.max(FACT_READING_MIN, readNeed));
  let meaning = width - what - reading - meter - gaps;
  if (meaning < FACT_MEANING_MIN && reading > FACT_READING_MIN) {
    reading = Math.max(FACT_READING_MIN, reading - (FACT_MEANING_MIN - meaning));
    meaning = width - what - reading - meter - gaps;
  }
  if (meaning < FACT_MEANING_MIN && what > FACT_WHAT_MIN) {
    what = Math.max(FACT_WHAT_MIN, what - (FACT_MEANING_MIN - meaning));
    meaning = width - what - reading - meter - gaps;
  }
  return { what, reading, meaning: Math.max(0, meaning), meter };
}

const PROBE_HEALTH = new Set(["http", "tcp", "command"]);

export function usesTrafficHealth(svc?: ServiceConfig): boolean {
  return PROBE_HEALTH.has((svc?.health.type ?? "").toLowerCase());
}

export function platformLabel(id: string): string {
  if (id === "darwin") {
    return "macOS";
  }
  if (id === "win32") {
    return "Windows";
  }
  if (id === "linux") {
    return "Linux";
  }
  return id || "this computer";
}

export function loadCopy(load: number, cpuCount: number): StatsFact {
  const cores = Math.max(1, cpuCount);
  const tone = loadTone(load, cores);
  const reading = tone === "error" ? "overloaded" : tone === "warning" ? "busy" : "not busy";
  const meaning =
    tone === "error"
      ? `${cores} cores are queued up — last minute ${formatLoadAvg(load)}`
      : tone === "warning"
        ? `${cores} cores nearly full — last minute ${formatLoadAvg(load)}`
        : `${cores} cores. Last minute ${formatLoadAvg(load)} (under ${cores} is fine)`;
  return { what: "CPU work", reading, meaning, tone, meter: resourceMeter(loadPerCpu(load, cores)) };
}

export function leftoverCopy(leftoverKB: number, totalKB: number): StatsFact {
  const tone = leftoverTone(leftoverKB, totalKB);
  const reading = `${formatMemoryKB(leftoverKB)} of ${formatMemoryKB(totalKB)}`;
  const meaning =
    tone === "error"
      ? "Almost no RAM left for new work"
      : tone === "warning"
        ? "RAM is getting tight"
        : "RAM the computer can still give out";
  const used = totalKB > 0 ? Math.max(0, (totalKB - leftoverKB) / totalKB) : 0;
  return { what: "RAM leftover", reading, meaning, tone, meter: resourceMeter(used) };
}

export function serviceStatusLabel(rt?: Runtime): string {
  const state = rt?.state ?? "STOPPED";
  if (state === "FAILED") {
    return "crashed";
  }
  if (state === "STOPPING") {
    return "stopping";
  }
  if (state === "STARTING" || state === "RESTARTING") {
    return "starting";
  }
  if (isLiveProcessState(state)) {
    return "up";
  }
  return "off";
}

export function serviceCheckLabel(rt?: Runtime): string {
  if (!rt || !isLiveProcessState(rt.state)) {
    return "—";
  }
  if (rt.health === "HEALTHY") {
    return "ready";
  }
  if (rt.health === "UNHEALTHY") {
    return "failing";
  }
  if (rt.state === "STARTING" || rt.state === "RESTARTING") {
    return "waiting";
  }
  return "checking";
}

export function credentialStoreLabel(backend: string): string {
  if (backend === "keychain") {
    return "password store";
  }
  if (backend === "file") {
    return "local file";
  }
  return backend || "unknown store";
}

export function fleetFacts(stats: ServiceFleetStats, probes: boolean): StatsFact[] {
  const rows: StatsFact[] = [
    {
      what: "Started",
      reading: String(stats.live),
      meaning: stats.live === 0 ? "nothing is running yet" : "process is up",
      tone: stats.live > 0 ? "success" : "muted",
    },
  ];
  if (probes) {
    rows.push({
      what: "Ready",
      reading: String(stats.healthy),
      meaning: stats.live === 0 ? "start services first" : "passed their health check",
      tone: stats.live > 0 && stats.healthy < stats.live ? "warning" : stats.healthy > 0 ? "success" : "muted",
    });
  }
  if (stats.starting > 0) {
    rows.push({
      what: "Still starting",
      reading: String(stats.starting),
      meaning: "not ready for traffic yet",
      tone: "warning",
    });
  }
  if (stats.stopping > 0) {
    rows.push({
      what: "Stopping",
      reading: String(stats.stopping),
      meaning: "shutting down",
      tone: "warning",
    });
  }
  rows.push({
    what: "Crashed",
    reading: String(stats.failed),
    meaning: stats.failed > 0 ? "open the service for the error" : "none",
    tone: stats.failed > 0 ? "error" : "muted",
  });
  rows.push({
    what: "Not started",
    reading: String(stats.stopped),
    meaning: stats.stopped > 0 ? "off until you start them" : "all are up",
    tone: "muted",
  });
  return rows;
}

// Shared gauge glyph: a block-character bar. Color selection stays at each
// call site since severity semantics differ per section (health ratio vs.
// error ratio vs. restart budget).
export function renderBar(ratio: number, len = 20): string {
  const safeRatio = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(safeRatio * len);
  return "█".repeat(filled) + "░".repeat(Math.max(0, len - filled));
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < MS_PER_SECOND) {
    return "< 1s";
  }
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

const KB_PER_MB = 1024;
const MB_PER_GB = 1024;

export function formatMemoryKB(kb: number): string {
  if (!Number.isFinite(kb) || kb < 0) {
    return "—";
  }
  const mb = kb / KB_PER_MB;
  if (mb >= MB_PER_GB) {
    return `${(mb / MB_PER_GB).toFixed(1)}G`;
  }
  if (mb >= 1) {
    return `${Math.round(mb)}M`;
  }
  return `${Math.round(kb)}K`;
}

export function formatCpuPercent(pct: number): string {
  if (!Number.isFinite(pct) || pct < 0) {
    return "—";
  }
  return `${pct.toFixed(1)}%`;
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
  if (state === "UNHEALTHY") {
    return "unhealthy — retrying health check";
  }
  if (state === "STOPPING") {
    return "stopping first";
  }
  if (state === "FAILED") {
    return "failed — later waves will not start";
  }
  const step = plan.steps.find((s) => s.name === name);
  const pending = (step?.dependencies ?? []).filter((dep) => {
    const depState = serviceLineState(snap?.services[dependencyName(dep)]);
    return dependencyCondition(dep) === "service_healthy"
      ? depState !== "HEALTHY"
      : depState === "STOPPED" || depState === "FAILED";
  }).map(dependencyName);
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

export type WaveStatus = "completed" | "active" | "unhealthy" | "failed" | "queued";

export function waveStatus(wave: string[], snap?: StatusSnapshot, kind: LifecycleKind = "start"): WaveStatus {
  if (wave.length === 0) {
    return "completed";
  }
  const runtimes = wave.map((name) => snap?.services[name]);
  if (runtimes.some((rt) => rt?.state === "FAILED")) {
    return "failed";
  }
  if (kind === "stop") {
    if (runtimes.every((rt) => !rt || rt.state === "STOPPED" || rt.state === "UNKNOWN")) {
      return "completed";
    }
    if (runtimes.some((rt) => rt?.state === "STOPPING")) {
      return "active";
    }
    return "queued";
  }
  const isHealthy = (rt?: Runtime): boolean =>
    Boolean(rt && (rt.state === "HEALTHY" || rt.health === "HEALTHY" || (rt.state === "RUNNING" && rt.health !== "UNHEALTHY")));
  if (runtimes.every(isHealthy)) {
    return "completed";
  }
  if (runtimes.some((rt) => rt?.state === "UNHEALTHY" || rt?.health === "UNHEALTHY")) {
    return "unhealthy";
  }
  if (runtimes.some((rt) => rt?.state === "STARTING" || rt?.state === "RUNNING" || rt?.state === "RESTARTING")) {
    return "active";
  }
  return "queued";
}

export type PlanProgressInfo = {
  total: number;
  ready: number;
  active: number;
  failed: number;
  percent: number;
  progressBar: string;
  currentWaveIndex: number;
  totalWaves: number;
  isComplete: boolean;
};

export function planProgress(plan: Plan, snap?: StatusSnapshot, kind: LifecycleKind = "start"): PlanProgressInfo {
  const allServices = plan.waves.flat();
  const total = allServices.length;
  let ready = 0;
  let failed = 0;
  let active = 0;
  let currentWaveIndex = 0;

  for (let i = 0; i < plan.waves.length; i++) {
    const wave = plan.waves[i] ?? [];
    const st = waveStatus(wave, snap, kind);
    if (st === "active" || st === "unhealthy" || st === "failed") {
      currentWaveIndex = i;
    } else if (st === "completed" && currentWaveIndex === i && i < plan.waves.length - 1) {
      currentWaveIndex = i + 1;
    }
    for (const name of wave) {
      const rt = snap?.services[name];
      const isDone =
        kind === "stop"
          ? !rt || rt.state === "STOPPED" || rt.state === "UNKNOWN"
          : Boolean(rt && (rt.state === "HEALTHY" || rt.health === "HEALTHY" || (rt.state === "RUNNING" && rt.health !== "UNHEALTHY")));
      if (isDone) {
        ready++;
      } else if (rt?.state === "FAILED") {
        failed++;
      } else if (
        rt?.state === "STARTING" ||
        rt?.state === "RUNNING" ||
        rt?.state === "UNHEALTHY" ||
        rt?.health === "UNHEALTHY" ||
        rt?.state === "STOPPING" ||
        rt?.state === "RESTARTING"
      ) {
        active++;
      }
    }
  }

  const percent = total > 0 ? Math.round((ready / total) * 100) : 100;
  const barLen = 16;
  const filled = Math.round((percent / 100) * barLen);
  const progressBar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
  const isComplete = ready === total && total > 0;

  return {
    total,
    ready,
    active,
    failed,
    percent,
    progressBar,
    currentWaveIndex,
    totalWaves: plan.waves.length,
    isComplete,
  };
}

export function waveCardTitle(kind: LifecycleKind, waveIdx: number, st: WaveStatus): string {
  const statusLabel =
    st === "completed"
      ? "✓ Completed"
      : st === "failed"
        ? "✗ Failed"
        : st === "unhealthy"
          ? "⚠ Unhealthy"
          : st === "active"
            ? "⏳ In Progress"
            : "○ Queued";
  const orderLabel =
    kind === "stop"
      ? waveIdx === 0
        ? "Wave 1 (Stop First)"
        : `Wave ${waveIdx + 1}`
      : waveIdx === 0
        ? "Wave 1 (Start First)"
        : `Wave ${waveIdx + 1}`;
  return `${orderLabel} · ${statusLabel}`;
}

export function planTitle(kind: LifecycleKind, busy: boolean, failed: string, profile?: string): string {
  const profileSuffix = profile ? ` · Profile ${profile}` : "";
  if (failed) {
    return `${kind === "stop" ? "Shutdown" : "Startup"} Failed (${failed})`;
  }
  if (busy) {
    return `${kind === "stop" ? "Stopping Services" : kind === "restart" ? "Restarting Pipeline" : "Starting Pipeline"}${profileSuffix}`;
  }
  return `${kind === "stop" ? "Shutdown Complete" : "Startup Complete"}${profileSuffix}`;
}

export function planActionCopy(busy: boolean, failed: string): { primary: string; secondary: string } {
  if (busy) {
    return {
      primary: "Working…  esc  hide this panel (keeps running in background)",
      secondary: "Services are transitioning. You can dismiss anytime without stopping them.",
    };
  }
  if (failed) {
    return {
      primary: "enter or esc  back to dashboard",
      secondary: "Execution stopped. Check logs or open Doctor to resolve errors.",
    };
  }
  return {
    primary: "enter or esc  back to dashboard",
    secondary: "All waves finished. Click here or press enter to continue.",
  };
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
  if (overlay === "log-details" || overlay === "scroll-text") {
    return [
      { key: "j/k", label: "scroll" },
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
  if (overlay === "config-edit") {
    return [
      { key: "ctrl+s", label: "save" },
      { key: "esc", label: "discard" },
    ];
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
        { key: "*", label: "all" },
        { key: "-", label: "none" },
        { key: "enter", label: "start or open" },
        { key: "n", label: "start" },
        { key: "x", label: "stop" },
        { key: "r", label: "refresh" },
        { key: "R", label: "restart" },
        { key: "←→", label: "log filter" },
        { key: "g", label: "latest" },
        { key: "z", label: "full logs" },
        { key: "i", label: "internal logs" },
        { key: "ctrl+l", label: "clear logs" },
        { key: copyKey, label: "copy logs" },
        { key: "j/k", label: "move" },
        ...common,
      ];
    case "services":
      return [
        { key: "enter", label: "detail" },
        { key: "space", label: "select" },
        { key: "*", label: "all" },
        { key: "-", label: "none" },
        { key: "n", label: "start" },
        { key: "x", label: "stop" },
        { key: "r", label: "refresh" },
        { key: "R", label: "restart" },
        ...common,
      ];
    case "detail":
      return [{ key: "j/k", label: "scroll env" }, { key: "n", label: "start" }, { key: "x", label: "stop" }, { key: "o", label: "config" }, { key: "l", label: "logs" }, { key: "esc", label: "back" }, ...common];
    case "logs":
      return [
        { key: "←→", label: "filter" },
        { key: "1-9", label: "source" },
        { key: "e", label: "errors" },
        { key: "i", label: "internal logs" },
        { key: "ctrl+l", label: "clear logs" },
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
      return [{ key: "space", label: "set current" }, { key: "enter", label: "set and start" }, { key: "j/k", label: "move" }, ...common];
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
      return [{ key: "v", label: "buffer" }, { key: "e", label: "editor" }, { key: "/diff", label: "sources" }, { key: "/reload", label: "reload" }, { key: "j/k", label: "scroll" }, ...common];
    case "setup":
      return [{ key: "j/k", label: "steps" }, { key: "enter", label: "continue" }, { key: "esc", label: "back or exit" }, ...common];
    case "doctor":
      return [{ key: "r", label: "run doctor again" }, { key: "j/k", label: "move" }, { key: "enter", label: "fix port" }, ...common];
    case "auth":
      return [
        { key: "r", label: "probe identities" },
        { key: "/auth login", label: "ADC login" },
        { key: "/auth logout", label: "revoke ADC" },
        { key: "/auth refresh", label: "probe" },
        ...common,
      ];
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
  // Set directly in this service's own `environment.vars`/`environment.defaults`
  // — as opposed to dotenv, profile, secrets, plugin, or runtime-injected — so
  // the UI can call out what the user actually wrote in config.
  fromConfig: boolean;
};

export function serviceEnvEntries(
  svc: ServiceConfig,
  reveal: boolean,
  extraMarkers: string[],
  extraPatterns: string[],
  resolved?: Record<string, string>,
): ServiceEnvEntry[] {
  const configured = { ...svc.environment.defaults, ...svc.environment.vars };
  const merged = resolved ?? configured;
  const redacted = redactEnv(merged, reveal, extraMarkers, extraPatterns);
  const keys = new Set([...Object.keys(redacted), ...svc.environment.required]);
  return [...keys]
    .map((key) => ({
      key,
      value: redacted[key] ?? "",
      required: svc.environment.required.includes(key),
      fromConfig: Object.prototype.hasOwnProperty.call(configured, key),
    }))
    .sort((a, b) => (a.fromConfig === b.fromConfig ? a.key.localeCompare(b.key) : a.fromConfig ? -1 : 1));
}

export function previousSessionNote(leftover?: PersistedState, currentSession?: string): PersistedState | undefined {
  if (!leftover || leftover.processes.length === 0) {
    return undefined;
  }
  if (currentSession !== undefined && currentSession !== "" && leftover.session_id === currentSession) {
    return undefined;
  }
  return leftover;
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

export function googleProjectDisplay(
  cfg?: { google?: { project_id?: string } },
  identity?: { project?: string; project_source?: string },
  google?: { projectID?: string; projectSource?: string },
): { project: string; source: string } {
  const configured = cfg?.google?.project_id ?? "";
  if (configured !== "") {
    return { project: configured, source: "configuration" };
  }
  const detected = identity?.project || google?.projectID || "";
  const source = identity?.project_source || google?.projectSource || "";
  return { project: detected, source };
}

export type StatusStripChip = {
  label: string;
  tone: "idle" | "muted" | "primary" | "accent" | "info" | "success" | "warning" | "error";
};

export function statusStripChips(
  email: string | undefined,
  project: string | undefined,
  logsTotal: number,
  paneWidth: number,
): StatusStripChip[] {
  const budget = Math.max(8, paneWidth - 2);
  const logsText = `logs ${logsTotal}`;
  const logsCost = tabChipWidth(logsText);
  const user = email || "(no user)";
  const rawProject = project || "";

  if (budget <= logsCost + 6) {
    const userBudget = Math.max(2, budget - logsCost - 2);
    return [
      { label: clipText(user, userBudget), tone: "idle" },
      { label: clipText(logsText, logsCost - 2), tone: "muted" },
    ];
  }

  const remaining = budget - logsCost;

  if (rawProject && remaining >= 36) {
    const projLabel = clipText(rawProject, 14);
    const projCost = tabChipWidth(projLabel);
    const userBudget = remaining - projCost - 2;
    const userPrefix = userBudget >= user.length + 9 ? `identity ${user}` : user;
    const userLabel = clipText(userPrefix, userBudget);
    return [
      { label: userLabel, tone: "idle" },
      { label: projLabel, tone: "muted" },
      { label: logsText, tone: "muted" },
    ];
  }

  if (rawProject && remaining >= 28 && rawProject.length <= 10) {
    const projLabel = clipText(rawProject, 10);
    const projCost = tabChipWidth(projLabel);
    const userBudget = remaining - projCost - 2;
    return [
      { label: clipText(user, userBudget), tone: "idle" },
      { label: projLabel, tone: "muted" },
      { label: logsText, tone: "muted" },
    ];
  }

  const userPrefix = remaining >= user.length + 9 ? `identity ${user}` : user;
  const userLabel = clipText(userPrefix, remaining - 2);
  return [
    { label: userLabel, tone: "idle" },
    { label: logsText, tone: "muted" },
  ];
}

// The message a ConfigurationReloadFailed event's persistent banner shows.
// Falls back for a missing or malformed payload rather than rendering
// "undefined" — an ordinary bus event still guarantees a type, not a
// well-formed payload.
export function reloadFailureMessage(ev: BusEvent): string {
  const message = ev.payload?.error;
  return typeof message === "string" && message !== "" ? message : "configuration reload failed";
}
