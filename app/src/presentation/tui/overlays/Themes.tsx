import { useDensity } from "../density.tsx";
import { overlayRect } from "../helpers.ts";
import { OverlayShell } from "../layout.tsx";
import { isCompactScale } from "../settings.ts";
import { THEME_BLURBS, THEME_NAMES, type Palette } from "../themes.ts";

const THEMES_W = 52;
const THEMES_H = 22;

export function ThemesOverlay(props: {
  palette: Palette;
  themeName: string;
  selected: number;
  termW: number;
  termH: number;
  onIndex: (index: number) => void;
  onPreview: (name: string) => void;
  onPick: (name: string) => void;
}) {
  const { palette, themeName, selected, termW, termH, onIndex, onPreview, onPick } = props;
  const options = THEME_NAMES.map((name) => ({
    name: name === themeName ? `${name}  (active)` : name,
    description: name === themeName ? `${THEME_BLURBS[name]}  ·  current` : THEME_BLURBS[name],
    value: name,
  }));
  const rect = overlayRect(termW, termH, THEMES_W, THEMES_H, "center", !isCompactScale(useDensity()));
  return (
    <OverlayShell palette={palette} title="/themes" bottomTitle="enter save  ·  esc revert" termW={termW} termH={termH} preferW={THEMES_W} preferH={THEMES_H}>
      <select
        height={Math.max(4, rect.height - 3)}
        options={options}
        selectedIndex={selected}
        showDescription
        showSelectionIndicator
        wrapSelection
        backgroundColor={palette.panel}
        focusedBackgroundColor={palette.panel}
        textColor={palette.text}
        focusedTextColor={palette.text}
        selectedBackgroundColor={palette.highlight}
        selectedTextColor={palette.primary}
        descriptionColor={palette.muted}
        selectedDescriptionColor={palette.accent}
        onChange={(index) => {
          onIndex(index);
          const name = THEME_NAMES[index];
          if (name) {
            onPreview(name);
          }
        }}
        onSelect={(_, option) => {
          const name = option?.value;
          if (typeof name === "string" && name !== "") {
            onPick(name);
          }
        }}
      />
    </OverlayShell>
  );
}
