import { type CommandSpec } from "../commands.ts";
import { useDensity } from "../density.tsx";
import { commandSelectOptions, overlayRect } from "../helpers.ts";
import { OverlayShell } from "../layout.tsx";
import { isCompactScale } from "../settings.ts";
import { type Palette } from "../themes.ts";

export function PaletteOverlay(props: {
  palette: Palette;
  items: CommandSpec[];
  selected: number;
  termW: number;
  termH: number;
  onIndex: (index: number) => void;
  onPick: (name: string) => void;
}) {
  const { palette, items, selected, termW, termH, onIndex, onPick } = props;
  const options = commandSelectOptions(items);
  const rect = overlayRect(termW, termH, 64, 18, "center", !isCompactScale(useDensity()));
  return (
    <OverlayShell palette={palette} title="commands" bottomTitle="enter select  ·  esc close" termW={termW} termH={termH} preferW={64} preferH={18}>
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
        onChange={(index) => onIndex(index)}
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
