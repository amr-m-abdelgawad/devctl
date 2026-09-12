import { type ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, type Ref } from "react";
import { formatBodySummary, stringifyAnyValue, type LogRecord } from "../../../domain/logs/logs.ts";
import type { Span, SpanKind, TraceTree } from "../../../domain/telemetry/types.ts";
import { overlayRect } from "../helpers/chrome.ts";
import { padClip } from "../helpers/format.ts";
import { displayLogLevel } from "../helpers/logs.ts";
import {
  clampTraceSpanIndex,
  fitTraceChips,
  formatSpanDuration,
  isTraceDoubleClick,
  longestServiceName,
  orderTraceRows,
  relativeEventMs,
  spanBarPlacement,
  spanDurationMs,
  TRACE_OVERLAY_MIN_H,
  TRACE_OVERLAY_MIN_W,
  traceAxisLabel,
  traceBodyLayout,
  traceColumnWidths,
  traceFacts,
  traceGutterWidth,
  traceHeaderCells,
  traceKindLabel,
  traceKindLegend,
  traceMaxDepth,
  traceOverlayPreferSize,
  traceServicesLine,
  traceStatusLabel,
  traceSummaryChips,
  traceTreeCell,
  traceWaterfallSegments,
  type TraceColumnWidths,
  type TraceFacts,
  type TraceHeaderChip,
  type TraceRow,
} from "../helpers/traces.ts";
import { Chip, OverlayShell, scrollboxStyle } from "../layout.tsx";
import { isCompactScale } from "../settings.ts";
import { serviceColor, type Palette } from "../themes.ts";
import { useDensity } from "../density.tsx";

export function TraceOverlay(props: {
  palette: Palette;
  trace?: TraceTree;
  termW: number;
  termH: number;
  selected?: number;
  onSelect?: (index: number) => void;
  onOpenLogs?: (index: number) => void;
  scrollRef?: Ref<ScrollBoxRenderable>;
}) {
  const { palette, trace, termW, termH, onSelect, onOpenLogs, scrollRef } = props;
  const compact = isCompactScale(useDensity());
  const prefer = traceOverlayPreferSize(termW, termH);
  const rect = overlayRect(termW, termH, prefer.w, prefer.h, "center", !compact);
  const pad = compact ? 0 : 1;
  const inner = Math.max(TRACE_OVERLAY_MIN_W - 8, rect.width - 2 - pad * 2);
  const bodyH = Math.max(TRACE_OVERLAY_MIN_H - 4, rect.height - 2 - pad * 2);
  const rows = trace ? orderTraceRows(trace) : [];
  const facts = trace ? traceFacts(trace) : undefined;
  const layout = traceBodyLayout(inner, bodyH);
  const cols = traceColumnWidths(layout.listWidth, traceMaxDepth(rows), longestServiceName(rows));
  const selected = clampTraceSpanIndex(props.selected ?? 0, rows.length);
  const lastClick = useRef({ index: -1, at: 0 });
  useEffect(() => {
    const box = scrollRef && "current" in scrollRef ? scrollRef.current : null;
    if (!box || rows.length === 0) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      box.scrollChildIntoView(`trace-span-${selected}`);
    });
    return () => cancelAnimationFrame(frame);
  }, [rows.length, scrollRef, selected]);
  if (!trace || !facts) {
    return null;
  }
  const pickSpan = (index: number) => {
    const now = Date.now();
    const doubled = isTraceDoubleClick(lastClick.current.index, lastClick.current.at, index, now);
    lastClick.current = { index, at: now };
    onSelect?.(index);
    if (doubled) {
      onOpenLogs?.(index);
    }
  };
  return (
    <OverlayShell
      palette={palette}
      title={rect.width >= 48 ? `trace  ${trace.traceId}` : `trace  ${shortId(trace.traceId, 12)}`}
      bottomTitle="j/k span  ·  enter or double-click logs  ·  esc close"
      termW={termW}
      termH={termH}
      preferW={prefer.w}
      preferH={prefer.h}
      gap={0}
    >
      <TraceHeader palette={palette} facts={facts} width={inner} showServices={layout.showServices} showLegend={layout.showLegend} />
      <box flexGrow={1} height={layout.listHeight} flexDirection="column" overflow="hidden">
        <TraceTableHead palette={palette} cols={cols} durationMs={facts.durationMs} />
        <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
          <box flexDirection="column" overflow="hidden">
            {rows.length === 0 ? (
              <text fg={palette.muted}>{"no spans in this trace yet"}</text>
            ) : (
              rows.map((row, index) => (
                <TraceSpanRow
                  key={`${row.span.spanId}-${row.span.seq}`}
                  id={`trace-span-${index}`}
                  palette={palette}
                  row={row}
                  cols={cols}
                  facts={facts}
                  active={index === selected}
                  onPick={() => pickSpan(index)}
                />
              ))
            )}
          </box>
        </scrollbox>
      </box>
    </OverlayShell>
  );
}

export function SpanDetailsOverlay(props: {
  palette: Palette;
  span?: Span;
  records?: LogRecord[];
  termW: number;
  termH: number;
  scrollRef?: Ref<ScrollBoxRenderable>;
}) {
  const { palette, span, records = [], termW, termH, scrollRef } = props;
  if (!span) {
    return null;
  }
  return (
    <OverlayShell
      palette={palette}
      title={clipTitle(`${traceKindLabel(span.kind)}  ${span.name}`)}
      bottomTitle="j/k scroll  ·  esc back to trace"
      termW={termW}
      termH={termH}
      preferW={84}
      preferH={28}
      gap={0}
    >
      <SpanInspector palette={palette} span={span} records={records} scrollRef={scrollRef} />
    </OverlayShell>
  );
}

function TraceHeader(props: {
  palette: Palette;
  facts: TraceFacts;
  width: number;
  showServices: boolean;
  showLegend: boolean;
}) {
  const { palette, facts, width, showServices, showLegend } = props;
  const chips = fitTraceChips(traceSummaryChips(facts), width);
  const services = traceServicesLine(facts.services, width);
  return (
    <box flexShrink={0} flexDirection="column" overflow="hidden">
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0} backgroundColor={palette.element}>
        {chips.map((chip) => (
          <HeaderChip key={chip.id} palette={palette} chip={chip} />
        ))}
      </box>
      {showServices && services !== "" ? (
        <text fg={palette.muted} wrapMode="none">
          {services}
        </text>
      ) : null}
      {showLegend ? (
        <text fg={palette.muted} wrapMode="none">
          {traceKindLegend(width)}
        </text>
      ) : null}
    </box>
  );
}

function HeaderChip(props: { palette: Palette; chip: TraceHeaderChip }) {
  const { palette, chip } = props;
  return <Chip palette={palette} label={chip.label} tone={chip.tone} />;
}

function TraceTableHead(props: { palette: Palette; cols: TraceColumnWidths; durationMs: number }) {
  const { palette, cols, durationMs } = props;
  const head = traceHeaderCells(cols);
  const gutter = traceGutterWidth(cols);
  return (
    <box flexShrink={0} flexDirection="column" overflow="hidden">
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
        <Col width={cols.tree} fg={palette.muted} text={head.tree} raw />
        <Col width={cols.service} fg={palette.muted} text={head.service} raw />
        <Col width={cols.name} fg={palette.muted} text={head.name} raw />
        <Col width={cols.duration} fg={palette.muted} text={head.duration} raw />
        <Col width={cols.bar} fg={palette.muted} text={head.bar} raw />
      </box>
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
        <Col width={gutter} fg={palette.muted} text="" />
        <Col width={cols.bar} fg={palette.muted} text={traceAxisLabel(durationMs, cols.bar)} raw />
      </box>
    </box>
  );
}

function TraceSpanRow(props: {
  id: string;
  palette: Palette;
  row: TraceRow;
  cols: TraceColumnWidths;
  facts: TraceFacts;
  active: boolean;
  onPick: () => void;
}) {
  const { id, palette, row, cols, facts, active, onPick } = props;
  const service = typeof row.span.resource["service.name"] === "string" ? row.span.resource["service.name"] : "—";
  const duration = spanDurationMs(row.span);
  const windowNanos = Math.max(1, facts.endUnixNano - facts.startUnixNano);
  const place = spanBarPlacement(row.span, facts.startUnixNano, windowNanos);
  const bar = traceWaterfallSegments(place.offset, place.width, cols.bar);
  const failed = row.span.status.code === "error";
  const barColor = failed ? palette.error : kindColor(palette, row.span.kind);
  return (
    <box
      id={id}
      height={1}
      flexDirection="row"
      overflow="hidden"
      flexShrink={0}
      backgroundColor={active ? palette.highlight : undefined}
      onMouseDown={onPick}
    >
      <Col width={cols.tree} fg={barColor} text={traceTreeCell(row.depth, row.span.kind, cols.tree, active)} raw />
      <Col width={cols.service} fg={serviceColor(service, palette)} text={service} />
      <Col width={cols.name} fg={failed ? palette.error : palette.text} text={row.span.name} />
      <Col width={cols.duration} fg={palette.muted} text={formatSpanDuration(duration)} />
      <TraceBar width={cols.bar} trackFg={palette.muted} fillFg={barColor} lead={bar.lead} fill={bar.fill} trail={bar.trail} />
    </box>
  );
}

function SpanInspector(props: {
  palette: Palette;
  span: Span;
  records: LogRecord[];
  scrollRef?: Ref<ScrollBoxRenderable>;
}) {
  const { palette, span, records, scrollRef } = props;
  const service = typeof span.resource["service.name"] === "string" ? span.resource["service.name"] : "—";
  const attrs = Object.entries(span.attributes);
  const failed = span.status.code === "error";
  return (
    <box flexGrow={1} flexDirection="column" overflow="hidden">
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden">
          <TraceField palette={palette} label="status" value={statusLine(span)} tone={failed ? "error" : "text"} />
          <TraceField palette={palette} label="kind" value={traceKindLabel(span.kind)} />
          <TraceField palette={palette} label="service" value={service} />
          <TraceField palette={palette} label="duration" value={formatSpanDuration(spanDurationMs(span))} />
          <TraceField palette={palette} label="trace" value={span.traceId} />
          <TraceField palette={palette} label="span" value={span.spanId} />
          <TraceField palette={palette} label="parent" value={span.parentSpanId || "—"} />
          {span.scope ? (
            <TraceField
              palette={palette}
              label="scope"
              value={`${span.scope.name}${span.scope.version ? ` ${span.scope.version}` : ""}`}
            />
          ) : null}
          {attrs.length === 0 ? null : <text fg={palette.muted}>{"attributes"}</text>}
          {attrs.map(([key, value]) => (
            <text key={key} fg={palette.text} wrapMode="word">
              {`${key}  ${stringifyAnyValue(value)}`}
            </text>
          ))}
          {span.events.length === 0 ? null : <text fg={palette.muted}>{`events  ${span.events.length}`}</text>}
          {span.events.map((event, index) => (
            <box key={`${event.name}-${index}`} flexDirection="column" overflow="hidden">
              <text fg={palette.info} wrapMode="word">
                {`+${formatSpanDuration(relativeEventMs(span, event.timeUnixNano))}  ${event.name}`}
              </text>
              {Object.entries(event.attributes).map(([key, value]) => (
                <text key={key} fg={palette.muted} wrapMode="word">
                  {`  ${key}  ${stringifyAnyValue(value)}`}
                </text>
              ))}
            </box>
          ))}
          <TraceLogs palette={palette} records={records} spanId={span.spanId} />
        </box>
      </scrollbox>
    </box>
  );
}

const TRACE_LOG_MARK_COL = 2;
const TRACE_LOG_TIME_COL = 9;
const TRACE_LOG_LEVEL_COL = 8;
const TRACE_LOG_SERVICE_MIN = 8;
const TRACE_LOG_SERVICE_MAX = 14;

function TraceLogs(props: { palette: Palette; records: LogRecord[]; spanId?: string }) {
  const { palette, records, spanId } = props;
  if (records.length === 0) {
    return <text fg={palette.muted}>{"logs  none"}</text>;
  }
  const serviceWidth = traceLogServiceWidth(records);
  return (
    <box flexDirection="column" overflow="hidden">
      <text fg={palette.muted}>{`logs  ${records.length}  ·  → this span`}</text>
      {records.map((record) => {
        const linked = spanId !== undefined && record.spanId === spanId;
        const headline = formatBodySummary(record);
        return (
          <box key={record.seq} flexShrink={0} flexDirection="row" alignItems="flex-start" overflow="hidden">
            <Col width={TRACE_LOG_MARK_COL} fg={linked ? palette.primary : palette.muted} text={linked ? "→" : ""} />
            <Col width={TRACE_LOG_TIME_COL} fg={palette.muted} text={record.timestamp.slice(11, 19)} />
            <Col width={serviceWidth} fg={linked ? palette.primary : palette.text} text={record.service} />
            <Col width={TRACE_LOG_LEVEL_COL} fg={linked ? palette.primary : palette.muted} text={displayLogLevel(record.severityText)} />
            <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <text fg={linked ? palette.primary : palette.text} wrapMode="word" flexShrink={0} width="100%">
                {headline}
              </text>
            </box>
          </box>
        );
      })}
    </box>
  );
}

function traceLogServiceWidth(records: LogRecord[]): number {
  return Math.min(TRACE_LOG_SERVICE_MAX, Math.max(TRACE_LOG_SERVICE_MIN, records.reduce((max, record) => Math.max(max, record.service.length), 0)));
}

function TraceField(props: { palette: Palette; label: string; value: string; tone?: "text" | "error" }) {
  const { palette, label, value, tone = "text" } = props;
  return (
    <text fg={tone === "error" ? palette.error : palette.text} wrapMode="word">
      {`${padClip(label, 10)}${value}`}
    </text>
  );
}

function TraceBar(props: { width: number; trackFg: string; fillFg: string; lead: string; fill: string; trail: string }) {
  const { width, trackFg, fillFg, lead, fill, trail } = props;
  return (
    <box width={width} flexShrink={0} overflow="hidden">
      <text wrapMode="none">
        <span fg={trackFg}>{lead}</span>
        <span fg={fillFg}>{fill}</span>
        <span fg={trackFg}>{trail}</span>
      </text>
    </box>
  );
}

function Col(props: { width: number; fg: string; text: string; raw?: boolean }) {
  const { width, fg, text, raw } = props;
  return (
    <box width={width} flexShrink={0} overflow="hidden">
      <text fg={fg} wrapMode="none">
        {raw ? text : padClip(text, width)}
      </text>
    </box>
  );
}

function statusLine(span: Span): string {
  const code = traceStatusLabel(span.status.code);
  return span.status.message ? `${code}  ${span.status.message}` : code;
}

function kindColor(palette: Palette, kind: SpanKind): string {
  if (kind === "server") {
    return palette.info;
  }
  if (kind === "client") {
    return palette.primary;
  }
  if (kind === "producer" || kind === "consumer") {
    return palette.accent;
  }
  return palette.muted;
}

function shortId(value: string, keep: number): string {
  if (value.length <= keep) {
    return value;
  }
  return `${value.slice(0, keep)}…`;
}

function clipTitle(value: string): string {
  return value.length <= 42 ? value : `${value.slice(0, 41)}…`;
}
