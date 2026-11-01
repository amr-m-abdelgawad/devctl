import { useAnimationTick } from "@opentui/react";
import { useCallback, useState } from "react";
import type { Palette } from "../themes.ts";

// Adapted from BlackisPlay’s MIT-licensed loader. See THIRD_PARTY_NOTICES.md.
// Exact 14 × 13 pixel silhouette used by the web SVG, packed two rows per
// terminal cell. Keep the eye coordinates and foot phases aligned with it.
const GHOST_BODY = [
  "     ####     ",
  "   ########   ",
  "  ##########  ",
  " ############ ",
  " ############ ",
  " ############ ",
  "##############",
  "##############",
  "##############",
  "##############",
  "##############",
  "##############",
];

export function GhostLoader({ palette }: { palette: Palette }) {
  const [frame, setFrame] = useState(0);
  const advance = useCallback(() => {
    setFrame((value) => (value + 1) % 12);
  }, []);
  useAnimationTick(4, advance);
  const lifted = frame % 2 === 1;
  const pupilOffset = frame < 6 ? 0 : 1;
  const pixels = [...GHOST_BODY, lifted ? "  ###    ###  " : "###  ####  ###"].map((row) => [...row]);
  for (const left of [1, 7]) {
    for (let y = 3; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        if ((y === 3 || y === 7) && (x === 0 || x === 3)) continue;
        pixels[y]![left + x] = "e";
      }
    }
    for (const y of [5, 6]) {
      for (const x of [0, 1]) pixels[y]![left + x + pupilOffset] = "p";
    }
  }
  const blank = Array<string>(14).fill(" ");
  const rows = lifted ? [...pixels, blank] : [blank, ...pixels];
  const pixelColor = (pixel: string | undefined) => pixel === "#" ? palette.primary : pixel === "e" ? palette.text : pixel === "p" ? palette.background : palette.panel;
  return (
    <box height={9} minHeight={0} flexShrink={1} flexDirection="column" alignItems="center" overflow="hidden">
      {Array.from({ length: 7 }, (_, y) => (
        <text key={y} height={1} flexShrink={0} wrapMode="none">
          {rows[y * 2]!.map((pixel, x) => (
            <span key={x} fg={pixelColor(pixel)} bg={pixelColor(rows[y * 2 + 1]?.[x])}>▀</span>
          ))}
        </text>
      ))}
      <box height={1} flexShrink={0} />
      <text height={1} flexShrink={0} fg={palette.muted} wrapMode="none">{lifted ? "   ░░░░░░░░   " : "  ▒▒▒▒▒▒▒▒▒▒  "}</text>
    </box>
  );
}
