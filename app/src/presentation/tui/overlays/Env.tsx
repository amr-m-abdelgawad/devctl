import { useDensity } from "../density.tsx";
import { overlayRect } from "../helpers/chrome.ts";
import { OverlayShell } from "../layout.tsx";
import { isCompactScale } from "../settings.ts";
import { type Palette } from "../themes.ts";

const ENV_W = 56;
const ENV_H = 16;

export type EnvOption = {
  name: string;
  description: string;
  current: boolean;
  started: boolean;
};

export function EnvOverlay(props: {
  palette: Palette;
  service: string;
  options: EnvOption[];
  selected: number;
  termW: number;
  termH: number;
  onIndex: (index: number) => void;
  onPick: (name: string) => void;
}) {
  const { palette, service, options, selected, termW, termH, onIndex, onPick } = props;
  const rows = options.map((option) => ({
    name: option.current ? `${option.name}  (active)` : option.name,
    description: option.description,
    value: option.name,
  }));
  const rect = overlayRect(termW, termH, ENV_W, ENV_H, "center", !isCompactScale(useDensity()));
  return (
    <OverlayShell palette={palette} title={`/env ${service}`} bottomTitle="enter switch  ·  esc cancel" termW={termW} termH={termH} preferW={ENV_W} preferH={ENV_H}>
      <select
        height={Math.max(4, rect.height - 3)}
        options={rows}
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
