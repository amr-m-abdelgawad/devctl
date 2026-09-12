import { type ScrollBoxRenderable } from "@opentui/core";
import { type Ref } from "react";
import { formatBodySummary, stringifyAnyValue, type LogRecord } from "../../../domain/logs/logs.ts";
import { displayLogLevel, prettyPrintLogRecord, prettyPrintLogRaw, stripAnsi } from "../helpers/logs.ts";
import { OverlayShell, scrollboxStyle } from "../layout.tsx";
import { serviceColor, type Palette } from "../themes.ts";

export function LogDetailsOverlay(props: {
  palette: Palette;
  event?: LogRecord;
  termW: number;
  termH: number;
  scrollRef?: Ref<ScrollBoxRenderable>;
  onViewTrace?: (traceId: string) => void;
}) {
  const { palette, event, termW, termH, scrollRef, onViewTrace } = props;
  if (!event) {
    return null;
  }
  const traceId = event.traceId;
  const bodyPretty = typeof event.body === "object" && event.body !== null ? prettyPrintLogRecord(event) : undefined;
  const rawPretty = event.raw && event.raw !== formatBodySummary(event) ? prettyPrintLogRaw(event.raw) : undefined;
  const attrEntries = Object.entries(event.attributes);
  const tall = formatBodySummary(event).length > 120 || formatBodySummary(event).includes("\n") || bodyPretty !== undefined || attrEntries.length > 0;
  const pid = event.resource["process.pid"];
  return (
    <OverlayShell
      palette={palette}
      title="log details"
      bottomTitle={traceId ? "enter view trace  ·  j/k scroll  ·  esc close" : "j/k scroll  ·  esc close"}
      termW={termW}
      termH={termH}
      preferW={tall ? 84 : 72}
      preferH={tall ? 24 : 16}
      gap={1}
    >
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden">
          <text fg={palette.text} wrapMode="word">
            {stripAnsi(formatBodySummary(event))}
          </text>
          <text fg={palette.muted}>{`time      ${event.timestamp}`}</text>
          <text fg={serviceColor(event.service, palette)}>{`service   ${event.service}`}</text>
          <text fg={palette.muted}>{`source    ${event.source}${event.stream ? ` / ${event.stream}` : ""}`}</text>
          <text fg={palette.muted}>{`level     ${displayLogLevel(event.severityText)} (${event.severityNumber})`}</text>
          <text fg={palette.muted}>{`pid       ${typeof pid === "number" && pid > 0 ? pid : "—"}`}</text>
          <text fg={palette.muted}>{`trace     ${traceId || "—"}`}</text>
          <text fg={palette.muted}>{`span      ${event.spanId || "—"}`}</text>
          <text fg={palette.muted}>{`identity  ${event.identity || "—"}`}</text>
          {event.scope ? <text fg={palette.muted}>{`scope     ${event.scope.name}${event.scope.version ? ` ${event.scope.version}` : ""}`}</text> : null}
          {attrEntries.length === 0 ? null : (
            <>
              <text fg={palette.muted}>{"attributes"}</text>
              {attrEntries.map(([key, value]) => (
                <text key={key} fg={palette.text} wrapMode="word">
                  {`${key}  ${stringifyAnyValue(value)}`}
                </text>
              ))}
            </>
          )}
          {bodyPretty === undefined ? null : (
            <>
              <text fg={palette.muted}>{"body"}</text>
              <text fg={palette.text} wrapMode="word">
                {bodyPretty}
              </text>
            </>
          )}
          {rawPretty === undefined || rawPretty === bodyPretty ? null : (
            <>
              <text fg={palette.muted}>{"raw"}</text>
              <text fg={palette.text} wrapMode="word">
                {rawPretty}
              </text>
            </>
          )}
          {traceId && onViewTrace ? (
            <text fg={palette.primary} onMouseDown={() => onViewTrace(traceId)}>
              {"view trace ↵"}
            </text>
          ) : null}
        </box>
      </scrollbox>
    </OverlayShell>
  );
}
