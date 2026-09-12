import { NANOS_PER_MS } from "../../../domain/logs/types.ts";
import type { Span, SpanKind, SpanStatusCode, TraceTree } from "../../../domain/telemetry/types.ts";
import { clipText, padClip } from "./format.ts";

export const TRACE_OVERLAY_MIN_W = 64;
export const TRACE_OVERLAY_MIN_H = 16;
export const TRACE_TREE_COL = 6;
export const TRACE_DURATION_COL = 7;
export const TRACE_SPAN_PAGE = 5;
export const TRACE_KIND_LEGEND = "◀ server  ▶ client  ● internal  ▲ producer  ▼ consumer";
export const TRACE_DOUBLE_CLICK_MS = 400;
const TRACE_WALK_MAX = 16;
const TRACE_INDENT = 2;
const TRACE_CURSOR_COL = 1;
const TRACE_GLYPH_COL = 1;
const TRACE_SERVICE_MIN = 6;
const TRACE_SERVICE_MAX_WIDE = 16;
const TRACE_SERVICE_MAX_MID = 14;
const TRACE_SERVICE_MAX_NARROW = 10;
const TRACE_NAME_MIN_WIDE = 12;
const TRACE_NAME_MIN_NARROW = 6;
const TRACE_BAR_MIN_WIDE = 14;
const TRACE_BAR_MIN_NARROW = 8;
const TRACE_BAR_SHARE = 0.55;
const TRACE_WIDE_INNER = 56;
const TRACE_CHIP_PAD = 2;
const TRACE_HEADER_SERVICES_MIN_H = 20;
const TRACE_HEADER_LEGEND_MIN_H = 16;
const MS_PER_SECOND = 1000;

export type TraceRow = {
  span: Span;
  depth: number;
};

export type TraceFacts = {
  durationMs: number;
  spanCount: number;
  serviceCount: number;
  errorCount: number;
  services: string[];
  startUnixNano: number;
  endUnixNano: number;
};

export type TraceColumnWidths = {
  tree: number;
  service: number;
  name: number;
  duration: number;
  bar: number;
};

export type TraceHeaderChip = {
  id: string;
  label: string;
  tone: "primary" | "ghost" | "success" | "error";
};

export type TraceBodyLayout = {
  listWidth: number;
  headerLines: number;
  showServices: boolean;
  showLegend: boolean;
  listHeight: number;
};

export type SpanBarColumns = {
  start: number;
  end: number;
};

export function spanDurationMs(span: Span): number {
  const start = Math.min(span.startUnixNano, span.endUnixNano);
  const end = Math.max(span.startUnixNano, span.endUnixNano);
  return Math.max(0, (end - start) / NANOS_PER_MS);
}

export function formatSpanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0ms";
  }
  if (ms > 0 && ms < 1) {
    return `${ms.toFixed(1)}ms`;
  }
  if (ms < MS_PER_SECOND) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / MS_PER_SECOND).toFixed(2)}s`;
}

export function traceKindGlyph(kind: SpanKind): string {
  if (kind === "server") {
    return "◀";
  }
  if (kind === "client") {
    return "▶";
  }
  if (kind === "producer") {
    return "▲";
  }
  if (kind === "consumer") {
    return "▼";
  }
  return "●";
}

export function traceKindLabel(kind: SpanKind): string {
  return `${traceKindGlyph(kind)} ${kind}`;
}

export function traceStatusLabel(code: SpanStatusCode): string {
  if (code === "error") {
    return "ERR";
  }
  if (code === "ok") {
    return "ok";
  }
  return "—";
}

export function orderTraceRows(tree: TraceTree): TraceRow[] {
  const byParent = new Map<string, Span[]>();
  const ids = new Set(tree.spans.map((span) => span.spanId));
  for (const span of tree.spans) {
    const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : "";
    const list = byParent.get(parent) ?? [];
    list.push(span);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.startUnixNano - b.startUnixNano || a.seq - b.seq);
  }
  const rows: TraceRow[] = [];
  const seen = new Set<number>();
  walkTraceChildren(byParent, "", 0, seen, rows);
  const leftovers = [...tree.spans]
    .filter((span) => !seen.has(span.seq))
    .sort((a, b) => a.startUnixNano - b.startUnixNano || a.seq - b.seq);
  for (const span of leftovers) {
    if (!seen.has(span.seq)) {
      seen.add(span.seq);
      rows.push({ span, depth: 0 });
      walkTraceChildren(byParent, span.spanId, 1, seen, rows);
    }
  }
  return rows;
}

function walkTraceChildren(
  byParent: Map<string, Span[]>,
  parentId: string,
  depth: number,
  seen: Set<number>,
  rows: TraceRow[],
): void {
  const children = (byParent.get(parentId) ?? []).filter((span) => !seen.has(span.seq));
  for (const span of children) {
    seen.add(span.seq);
    rows.push({ span, depth: Math.min(depth, TRACE_WALK_MAX) });
    walkTraceChildren(byParent, span.spanId, depth + 1, seen, rows);
  }
}

export function traceFacts(tree: TraceTree): TraceFacts {
  if (tree.spans.length === 0) {
    return { durationMs: 0, spanCount: 0, serviceCount: 0, errorCount: 0, services: [], startUnixNano: 0, endUnixNano: 0 };
  }
  let start = Math.min(tree.spans[0]!.startUnixNano, tree.spans[0]!.endUnixNano);
  let end = Math.max(tree.spans[0]!.startUnixNano, tree.spans[0]!.endUnixNano);
  const names: string[] = [];
  let errors = 0;
  for (const span of tree.spans) {
    const lo = Math.min(span.startUnixNano, span.endUnixNano);
    const hi = Math.max(span.startUnixNano, span.endUnixNano);
    if (lo < start) {
      start = lo;
    }
    if (hi > end) {
      end = hi;
    }
    const service = span.resource["service.name"];
    if (typeof service === "string" && service !== "" && !names.includes(service)) {
      names.push(service);
    }
    if (span.status.code === "error") {
      errors += 1;
    }
  }
  return {
    durationMs: Math.max(0, (end - start) / NANOS_PER_MS),
    spanCount: tree.spans.length,
    serviceCount: names.length,
    errorCount: errors,
    services: names,
    startUnixNano: start,
    endUnixNano: end,
  };
}

export function traceMaxDepth(rows: readonly TraceRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.depth), 0);
}

export function longestServiceName(rows: readonly TraceRow[]): number {
  return rows.reduce((max, row) => {
    const name = typeof row.span.resource["service.name"] === "string" ? row.span.resource["service.name"] : "";
    return Math.max(max, name.length);
  }, "SERVICE".length);
}

export function traceTreeWidth(maxDepth: number): number {
  const depth = Math.max(0, Math.min(TRACE_WALK_MAX, maxDepth));
  return TRACE_CURSOR_COL + TRACE_GLYPH_COL + depth * TRACE_INDENT;
}

export function traceColumnWidths(inner: number, maxDepth = 0, longestService = TRACE_SERVICE_MAX_NARROW): TraceColumnWidths {
  const tree = Math.max(2, traceTreeWidth(maxDepth));
  const duration = TRACE_DURATION_COL;
  const serviceCap = inner >= 90 ? TRACE_SERVICE_MAX_WIDE : inner >= 70 ? TRACE_SERVICE_MAX_MID : TRACE_SERVICE_MAX_NARROW;
  let service = Math.max(TRACE_SERVICE_MIN, Math.min(serviceCap, longestService));
  const minName = inner >= TRACE_WIDE_INNER ? TRACE_NAME_MIN_WIDE : TRACE_NAME_MIN_NARROW;
  const minBar = inner >= TRACE_WIDE_INNER ? TRACE_BAR_MIN_WIDE : TRACE_BAR_MIN_NARROW;
  const restAfterFixed = inner - tree - service - duration;
  if (restAfterFixed < minName + minBar) {
    const need = minName + minBar - restAfterFixed;
    service = Math.max(TRACE_SERVICE_MIN, service - need);
  }
  const rest = Math.max(2, inner - tree - service - duration);
  let bar = Math.max(minBar, Math.round(rest * TRACE_BAR_SHARE));
  let name = rest - bar;
  if (name < minName) {
    name = Math.min(minName, Math.max(1, rest - minBar));
    bar = Math.max(1, rest - name);
  }
  const used = tree + service + duration + name + bar;
  if (used < inner) {
    bar += inner - used;
  }
  return {
    tree,
    service,
    name: Math.max(1, name),
    duration,
    bar: Math.max(1, bar),
  };
}

export function traceGutterWidth(cols: TraceColumnWidths): number {
  return cols.tree + cols.service + cols.name + cols.duration;
}

export function traceTreeCell(depth: number, kind: SpanKind, width = TRACE_TREE_COL, active = false): string {
  const maxIndent = Math.max(0, Math.floor((width - TRACE_CURSOR_COL - TRACE_GLYPH_COL) / TRACE_INDENT));
  const indent = Math.min(Math.max(0, depth), maxIndent) * TRACE_INDENT;
  const raw = `${active ? "▸" : " "}${" ".repeat(indent)}${traceKindGlyph(kind)}`;
  return padClip(raw, width);
}

export function spanBarPlacement(span: Span, windowStart: number, windowDuration: number): { offset: number; width: number } {
  if (windowDuration <= 0) {
    return { offset: 0, width: 1 };
  }
  const spanStart = Math.min(span.startUnixNano, span.endUnixNano);
  const spanEnd = Math.max(span.startUnixNano, span.endUnixNano);
  const offset = clampRatio((spanStart - windowStart) / windowDuration);
  const end = clampRatio((spanEnd - windowStart) / windowDuration);
  return { offset, width: Math.max(0, end - offset) };
}

export function spanBarColumns(offsetRatio: number, widthRatio: number, cols: number): SpanBarColumns {
  if (cols <= 0) {
    return { start: 0, end: 0 };
  }
  const lo = clampRatio(offsetRatio);
  const hi = clampRatio(offsetRatio + widthRatio);
  let start = Math.floor(lo * cols);
  let end = Math.ceil(hi * cols);
  if (end <= start) {
    end = start + 1;
  }
  start = Math.max(0, Math.min(cols - 1, start));
  end = Math.max(start + 1, Math.min(cols, end));
  return { start, end };
}

export type WaterfallBar = {
  lead: string;
  fill: string;
  trail: string;
};

export function traceWaterfallSegments(offsetRatio: number, widthRatio: number, cols: number): WaterfallBar {
  if (cols <= 0) {
    return { lead: "", fill: "", trail: "" };
  }
  const { start, end } = spanBarColumns(offsetRatio, widthRatio, cols);
  return {
    lead: "░".repeat(start),
    fill: "█".repeat(end - start),
    trail: "░".repeat(cols - end),
  };
}

export function traceWaterfallBar(offsetRatio: number, widthRatio: number, cols: number): string {
  const bar = traceWaterfallSegments(offsetRatio, widthRatio, cols);
  return `${bar.lead}${bar.fill}${bar.trail}`;
}

export function traceAxisLabel(durationMs: number, width: number): string {
  if (width <= 0) {
    return "";
  }
  const left = "0";
  const mid = formatSpanDuration(durationMs / 2);
  const right = formatSpanDuration(durationMs);
  if (width < left.length + mid.length + right.length + 2) {
    return padStartClip(right, width);
  }
  const midStart = Math.max(left.length + 1, Math.floor((width - mid.length) / 2));
  const line = Array.from({ length: width }, () => "─");
  writeAxis(line, 0, left);
  writeAxis(line, midStart, mid);
  writeAxis(line, width - right.length, right);
  return line.join("");
}

export function traceHeaderCells(cols: TraceColumnWidths): { tree: string; service: string; name: string; duration: string; bar: string } {
  return {
    tree: padClip("", cols.tree),
    service: padClip("SERVICE", cols.service),
    name: padClip("SPAN", cols.name),
    duration: padClip("DUR", cols.duration),
    bar: padClip("TIME", cols.bar),
  };
}

export function clampTraceSpanIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(count - 1, index));
}

export function isTraceDoubleClick(prevIndex: number, prevAt: number, index: number, now: number, windowMs = TRACE_DOUBLE_CLICK_MS): boolean {
  return prevIndex === index && now - prevAt <= windowMs;
}

export function relativeEventMs(span: Span, timeUnixNano: number): number {
  return Math.max(0, (timeUnixNano - span.startUnixNano) / NANOS_PER_MS);
}

export function traceSummaryChips(facts: TraceFacts): TraceHeaderChip[] {
  const spanLabel = facts.spanCount === 1 ? "1 span" : `${facts.spanCount} spans`;
  const serviceLabel = facts.serviceCount === 1 ? "1 service" : `${facts.serviceCount} services`;
  const errorLabel = facts.errorCount === 0 ? "no errors" : facts.errorCount === 1 ? "1 error" : `${facts.errorCount} errors`;
  return [
    { id: "dur", label: formatSpanDuration(facts.durationMs), tone: "primary" },
    { id: "spans", label: spanLabel, tone: "ghost" },
    { id: "svc", label: serviceLabel, tone: "ghost" },
    { id: "err", label: errorLabel, tone: facts.errorCount === 0 ? "success" : "error" },
  ];
}

export function fitTraceChips(chips: readonly TraceHeaderChip[], width: number): TraceHeaderChip[] {
  const fitted: TraceHeaderChip[] = [];
  let used = 0;
  for (const chip of chips) {
    const cost = chip.label.length + TRACE_CHIP_PAD;
    if (used + cost > width) {
      break;
    }
    fitted.push(chip);
    used += cost;
  }
  if (fitted.length > 0) {
    return fitted;
  }
  const first = chips[0];
  return first ? [{ ...first, label: clipText(first.label, Math.max(1, width - TRACE_CHIP_PAD)) }] : [];
}

export function traceServicesLine(services: readonly string[], width: number): string {
  if (services.length === 0 || width <= 0) {
    return "";
  }
  return clipText(services.join(" · "), width);
}

export function traceKindLegend(width: number): string {
  return clipText(TRACE_KIND_LEGEND, width);
}

export function traceOverlayPreferSize(termW: number, termH: number): { w: number; h: number } {
  return {
    w: Math.max(TRACE_OVERLAY_MIN_W, termW - 2),
    h: Math.max(TRACE_OVERLAY_MIN_H, termH - 1),
  };
}

export function traceBodyLayout(inner: number, bodyH: number): TraceBodyLayout {
  const showServices = bodyH >= TRACE_HEADER_SERVICES_MIN_H;
  const showLegend = bodyH >= TRACE_HEADER_LEGEND_MIN_H;
  const headerLines = 1 + (showServices ? 1 : 0) + (showLegend ? 1 : 0);
  return {
    listWidth: inner,
    headerLines,
    showServices,
    showLegend,
    listHeight: Math.max(6, bodyH - headerLines),
  };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function writeAxis(line: string[], start: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const at = start + i;
    if (at >= 0 && at < line.length) {
      line[at] = text[i] ?? "─";
    }
  }
}

function padStartClip(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }
  return value.padStart(width);
}
