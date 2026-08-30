import { OverlayShell } from "../layout.tsx";
import { serviceColor, type Palette } from "../themes.ts";
import { type LogEvent } from "../../logs.ts";

export function LogDetailsOverlay(props: { palette: Palette; event?: LogEvent; termW: number; termH: number }) {
  const { palette, event, termW, termH } = props;
  if (!event) {
    return null;
  }
  return (
    <OverlayShell
      palette={palette}
      title="log details"
      bottomTitle="esc close"
      termW={termW}
      termH={termH}
      preferW={event.message.length > 120 || event.message.includes("\n") ? 84 : 72}
      preferH={event.message.length > 120 || event.message.includes("\n") ? 22 : 14}
      gap={1}
    >
      <text fg={palette.text} wrapMode="word">
        {event.message}
      </text>
      <text fg={palette.muted}>{`time      ${event.timestamp}`}</text>
      <text fg={serviceColor(event.service, palette)}>{`service   ${event.service}`}</text>
      <text fg={palette.muted}>{`source    ${event.source}${event.stream ? ` / ${event.stream}` : ""}`}</text>
      <text fg={palette.muted}>{`level     ${event.level}`}</text>
      <text fg={palette.muted}>{`pid       ${event.pid || "—"}`}</text>
      <text fg={palette.muted}>{`request   ${event.request_id || "—"}`}</text>
      <text fg={palette.muted}>{`identity  ${event.identity || "—"}`}</text>
    </OverlayShell>
  );
}
