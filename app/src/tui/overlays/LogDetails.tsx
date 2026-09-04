import { type Ref } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import { OverlayShell, scrollboxStyle } from "../layout.tsx";
import { prettyPrintLogRaw, stripAnsi } from "../helpers.ts";
import { serviceColor, type Palette } from "../themes.ts";
import { type LogEvent } from "../../logs.ts";

export function LogDetailsOverlay(props: {
  palette: Palette;
  event?: LogEvent;
  termW: number;
  termH: number;
  scrollRef?: Ref<ScrollBoxRenderable>;
}) {
  const { palette, event, termW, termH, scrollRef } = props;
  if (!event) {
    return null;
  }
  const pretty = event.raw ? prettyPrintLogRaw(event.raw) : undefined;
  const tall = event.message.length > 120 || event.message.includes("\n") || pretty !== undefined;
  return (
    <OverlayShell
      palette={palette}
      title="log details"
      bottomTitle="j/k scroll  ·  esc close"
      termW={termW}
      termH={termH}
      preferW={tall ? 84 : 72}
      preferH={tall ? 22 : 14}
      gap={1}
    >
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden">
          <text fg={palette.text} wrapMode="word">
            {stripAnsi(event.message)}
          </text>
          <text fg={palette.muted}>{`time      ${event.timestamp}`}</text>
          <text fg={serviceColor(event.service, palette)}>{`service   ${event.service}`}</text>
          <text fg={palette.muted}>{`source    ${event.source}${event.stream ? ` / ${event.stream}` : ""}`}</text>
          <text fg={palette.muted}>{`level     ${event.level}`}</text>
          <text fg={palette.muted}>{`pid       ${event.pid || "—"}`}</text>
          <text fg={palette.muted}>{`request   ${event.request_id || "—"}`}</text>
          <text fg={palette.muted}>{`identity  ${event.identity || "—"}`}</text>
          {pretty === undefined ? null : (
            <>
              <text fg={palette.muted}>{"raw json"}</text>
              <text fg={palette.text} wrapMode="word">
                {pretty}
              </text>
            </>
          )}
        </box>
      </scrollbox>
    </OverlayShell>
  );
}
