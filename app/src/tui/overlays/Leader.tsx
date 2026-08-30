import { leaderHints } from "../helpers.ts";
import { KeyHints, OverlayShell } from "../layout.tsx";
import { type Palette } from "../themes.ts";

export function LeaderOverlay(props: { palette: Palette; termW: number; termH: number }) {
  const { palette, termW, termH } = props;
  const hints = leaderHints();
  return (
    <OverlayShell palette={palette} title="leader" termW={termW} termH={termH} preferW={68} preferH={5} anchor="bottom">
      <KeyHints palette={palette} hints={hints} />
    </OverlayShell>
  );
}
