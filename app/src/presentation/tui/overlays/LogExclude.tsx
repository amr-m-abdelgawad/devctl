import { useDensity } from "../density.tsx";
import { overlayRect } from "../helpers/chrome.ts";
import { OverlayShell } from "../layout.tsx";
import { isCompactScale } from "../settings.ts";
import { type Palette } from "../themes.ts";

const LOG_EXCLUDE_W = 52;
const LOG_EXCLUDE_H = 18;

export function LogExcludeOverlay(props: {
  palette: Palette;
  options: readonly string[];
  excluded: readonly string[];
  selected: number;
  termW: number;
  termH: number;
  onIndex: (index: number) => void;
  onToggle: (service: string) => void;
}) {
  const { palette, options, excluded, selected, termW, termH, onIndex, onToggle } = props;
  const rows = options.map((name) => ({
    name: `${excluded.includes(name) ? "[x]" : "[ ]"} ${name}`,
    description: "",
    value: name,
  }));
  const rect = overlayRect(termW, termH, LOG_EXCLUDE_W, LOG_EXCLUDE_H, "center", !isCompactScale(useDensity()));
  return (
    <OverlayShell palette={palette} title="/exclude" bottomTitle="space toggle  ·  c clear  ·  esc close" termW={termW} termH={termH} preferW={LOG_EXCLUDE_W} preferH={LOG_EXCLUDE_H}>
      {rows.length === 0 ? (
        <text fg={palette.muted}>no services yet</text>
      ) : (
        <select
          height={Math.max(4, rect.height - 3)}
          options={rows}
          selectedIndex={selected}
          showSelectionIndicator
          wrapSelection
          backgroundColor={palette.panel}
          focusedBackgroundColor={palette.panel}
          textColor={palette.text}
          focusedTextColor={palette.text}
          selectedBackgroundColor={palette.highlight}
          selectedTextColor={palette.primary}
          onChange={(index) => onIndex(index)}
          onSelect={(_, option) => {
            const name = option?.value;
            if (typeof name === "string" && name !== "") {
              onToggle(name);
            }
          }}
        />
      )}
    </OverlayShell>
  );
}
