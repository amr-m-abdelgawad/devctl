import { KeyHints, OverlayShell } from "../layout.tsx";
import { type Palette } from "../themes.ts";

export function ConfirmOverlay(props: { palette: Palette; title: string; body: string; termW: number; termH: number }) {
  const { palette, title, body, termW, termH } = props;
  return (
    <OverlayShell
      palette={palette}
      title={title}
      bottomTitle="enter confirm  ·  esc stay"
      termW={termW}
      termH={termH}
      preferW={52}
      preferH={8}
      borderColor={palette.warning}
      gap={1}
    >
      <text fg={palette.text} wrapMode="word">
        {body}
      </text>
      <KeyHints
        palette={palette}
        hints={[
          { key: "enter", label: "confirm" },
          { key: "esc", label: "stay" },
        ]}
      />
    </OverlayShell>
  );
}
