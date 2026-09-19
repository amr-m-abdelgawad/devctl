import { type ScrollBoxRenderable } from "@opentui/core";
import { type Ref } from "react";
import type { TrafficCall } from "../../../domain/traffic/traffic.ts";
import { clipText } from "../helpers/format.ts";
import { trafficBodyModeHint, type TrafficBodyMode } from "../helpers/traffic.ts";
import { OverlayShell, scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { TrafficInspector } from "../components/TrafficInspector.tsx";

const TITLE_MAX = 48;

export function TrafficDetailsOverlay(props: {
  palette: Palette;
  call?: TrafficCall;
  termW: number;
  termH: number;
  bodyMode?: TrafficBodyMode;
  onToggleBody?: () => void;
  scrollRef?: Ref<ScrollBoxRenderable>;
  onViewTrace?: (traceId: string) => void;
}) {
  const { palette, call, termW, termH, bodyMode = "json", onToggleBody, scrollRef, onViewTrace } = props;
  if (!call) {
    return null;
  }
  const traceId = call.traceId?.trim() ?? "";
  const title = clipText(`${call.method} ${call.path}` || "traffic", TITLE_MAX);
  const closeHint = `${traceId ? "enter view trace  ·  " : ""}r ${trafficBodyModeHint(bodyMode)}  ·  click ▸ expand json  ·  j/k scroll  ·  esc close  ·  /reveal is env only`;
  return (
    <OverlayShell
      palette={palette}
      title={title}
      bottomTitle={closeHint}
      termW={termW}
      termH={termH}
      preferW={90}
      preferH={28}
      gap={1}
    >
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box minWidth={0} width="100%">
          <TrafficInspector palette={palette} call={call} compact={false} bodyMode={bodyMode} onToggleBody={onToggleBody} onViewTrace={onViewTrace} />
        </box>
      </scrollbox>
    </OverlayShell>
  );
}
