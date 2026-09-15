import { type ScrollBoxRenderable } from "@opentui/core";
import { type Ref } from "react";
import type { LlmCall } from "../../../domain/llm/llm.ts";
import { formatLlmCaller, formatLlmCost, formatLlmDuration, formatLlmJson, formatLlmTokenBreakdown } from "../helpers/llm.ts";
import { OverlayShell, scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";

export function LlmDetailsOverlay(props: {
  palette: Palette;
  call?: LlmCall;
  termW: number;
  termH: number;
  scrollRef?: Ref<ScrollBoxRenderable>;
  onViewTrace?: (traceId: string) => void;
}) {
  const { palette, call, termW, termH, scrollRef, onViewTrace } = props;
  if (!call) {
    return null;
  }
  const attrs = Object.entries(call.attributes);
  const request = formatLlmJson(call.request);
  const response = formatLlmJson(call.response);
  const traceId = call.traceId?.trim() ?? "";
  const closeHint = `${traceId ? "enter view trace  ·  " : ""}j/k scroll  ·  esc close  ·  /reveal is env only`;
  return (
    <OverlayShell
      palette={palette}
      title="llm call"
      bottomTitle={closeHint}
      termW={termW}
      termH={termH}
      preferW={84}
      preferH={24}
      gap={1}
    >
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden">
          <text fg={palette.text} wrapMode="word">{call.model}</text>
          <text fg={palette.muted}>{`id        ${call.id}`}</text>
          <text fg={palette.muted}>{`source    ${call.source} (${call.sourceType})`}</text>
          <text fg={palette.muted}>{`caller    ${formatLlmCaller(call.caller)}`}</text>
          <text fg={palette.muted}>{`time      ${call.timestamp}`}</text>
          <text fg={call.status === "error" ? palette.error : palette.success}>{`status    ${call.status}`}</text>
          <text fg={palette.muted}>{`operation ${call.operation}`}</text>
          <text fg={palette.muted}>{`duration  ${formatLlmDuration(call.durationMs)}`}</text>
          <text fg={palette.muted}>{`tokens    ${formatLlmTokenBreakdown(call.usage)}`}</text>
          {call.usage || call.sourceType !== "proxy" ? null : (
            <text fg={palette.muted}>{"          streamed usage needs stream_options.include_usage"}</text>
          )}
          <text fg={palette.muted}>{`cost      ${formatLlmCost(call.cost)}`}</text>
          {call.routedModel ? <text fg={palette.muted}>{`routed    ${call.routedModel}`}</text> : null}
          {call.vendor ? <text fg={palette.muted}>{`vendor    ${call.vendor}`}</text> : null}
          {call.error ? <text fg={palette.error} wrapMode="word">{`error     ${call.error}`}</text> : null}
          <text fg={palette.muted}>{`request   ${call.requestId || "—"}`}</text>
          <text fg={palette.muted}>{`trace     ${traceId || "—"}`}</text>
          {attrs.length === 0 ? null : (
            <>
              <text fg={palette.muted}>{"attributes"}</text>
              {attrs.map(([key, value]) => (
                <text key={key} fg={palette.text} wrapMode="word">
                  {`${key}  ${formatLlmJson(value)}`}
                </text>
              ))}
            </>
          )}
          {request === "" ? null : (
            <>
              <text fg={palette.muted}>{"request"}</text>
              <text fg={palette.text} wrapMode="word">{request}</text>
            </>
          )}
          {response === "" ? null : (
            <>
              <text fg={palette.muted}>{"response"}</text>
              <text fg={palette.text} wrapMode="word">{response}</text>
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
