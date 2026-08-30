import { type Ref } from "react";
import { type TextareaRenderable } from "@opentui/core";
import { OverlayShell } from "../layout.tsx";
import { type Palette } from "../themes.ts";

export function ConfigEditOverlay(props: {
  palette: Palette;
  path: string;
  initialValue: string;
  error: string;
  termW: number;
  termH: number;
  textareaRef?: Ref<TextareaRenderable>;
}) {
  const { palette, path, initialValue, error, termW, termH, textareaRef } = props;
  return (
    <OverlayShell
      palette={palette}
      title="config buffer"
      bottomTitle="ctrl+s save  ·  esc discard  ·  e still opens $EDITOR"
      termW={termW}
      termH={termH}
      preferW={88}
      preferH={28}
      gap={1}
    >
      <box height={1} overflow="hidden">
        <text fg={palette.muted} wrapMode="none">
          {path}
        </text>
      </box>
      <textarea
        ref={textareaRef}
        focused
        initialValue={initialValue}
        backgroundColor={palette.panel}
        focusedBackgroundColor={palette.panel}
        textColor={palette.text}
        focusedTextColor={palette.text}
        cursorColor={palette.primary}
      />
      {error !== "" ? (
        <box height={2} overflow="hidden">
          <text fg={palette.error} wrapMode="word">
            {error}
          </text>
        </box>
      ) : (
        <box height={1} overflow="hidden">
          <text fg={palette.muted}>validate, then write. invalid YAML is not saved.</text>
        </box>
      )}
    </OverlayShell>
  );
}
