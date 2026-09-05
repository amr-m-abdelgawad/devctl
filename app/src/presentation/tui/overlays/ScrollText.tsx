import { type Ref } from "react";
import { type ScrollBoxRenderable } from "@opentui/core";
import { OverlayShell, scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";

export function ScrollTextOverlay(props: {
  palette: Palette;
  title: string;
  body: string;
  termW: number;
  termH: number;
  scrollRef?: Ref<ScrollBoxRenderable>;
}) {
  const { palette, title, body, termW, termH, scrollRef } = props;
  const tall = body.length > 400 || body.split("\n").length > 16;
  return (
    <OverlayShell
      palette={palette}
      title={title}
      bottomTitle="j/k scroll  ·  esc close"
      termW={termW}
      termH={termH}
      preferW={tall ? 88 : 76}
      preferH={tall ? 24 : 16}
      gap={1}
    >
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden">
          <text fg={body === "" ? palette.muted : palette.text} wrapMode="word">
            {body === "" ? "(empty)" : body}
          </text>
        </box>
      </scrollbox>
    </OverlayShell>
  );
}
