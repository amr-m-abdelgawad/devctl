import { confirmHints } from "../helpers/chrome.ts";
import { KeyHints, OverlayShell } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type ConfirmKind } from "../types.ts";

export function ConfirmOverlay(props: {
  palette: Palette;
  title: string;
  body: string;
  kind: ConfirmKind;
  termW: number;
  termH: number;
}) {
  const { palette, title, body, kind, termW, termH } = props;
  const hints = confirmHints(kind);
  const bottom = hints.map((hint) => `${hint.key} ${hint.label}`).join("  ·  ");
  return (
    <OverlayShell
      palette={palette}
      title={title}
      bottomTitle={bottom}
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
      <KeyHints palette={palette} hints={hints} />
    </OverlayShell>
  );
}
