import { type ScrollBoxRenderable } from "@opentui/core";
import { type Ref } from "react";
import type { LlmCall } from "../../../domain/llm/llm.ts";
import { clipText } from "../helpers/format.ts";
import { llmBodyModeHint, llmTurns, type LlmBodyMode } from "../helpers/llm.ts";
import { OverlayShell, scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { LlmInspector } from "../components/LlmInspector.tsx";

const TITLE_MAX = 48;

export function LlmDetailsOverlay(props: {
  palette: Palette;
  call?: LlmCall;
  termW: number;
  termH: number;
  bodyMode?: LlmBodyMode;
  onToggleBody?: () => void;
  scrollRef?: Ref<ScrollBoxRenderable>;
  onViewTrace?: (traceId: string) => void;
}) {
  const { palette, call, termW, termH, bodyMode = "conversation", onToggleBody, scrollRef, onViewTrace } = props;
  if (!call) {
    return null;
  }
  const traceId = call.traceId?.trim() ?? "";
  const title = clipText(call.model || "llm call", TITLE_MAX);
  const canToggle = llmTurns(call).length > 0;
  const bodyHint = canToggle ? `r ${llmBodyModeHint(bodyMode)}  ·  ` : "";
  const closeHint = `${traceId ? "enter view trace  ·  " : ""}${bodyHint}j/k scroll  ·  esc close  ·  /reveal is env only`;
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
        <LlmInspector palette={palette} call={call} width={Math.max(40, termW - 8)} compact={false} bodyMode={bodyMode} onToggleBody={onToggleBody} onViewTrace={onViewTrace} />
      </scrollbox>
    </OverlayShell>
  );
}
