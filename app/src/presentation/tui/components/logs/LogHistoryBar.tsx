import { MetaBar } from "../../layout.tsx";
import { type Palette } from "../../themes.ts";

export function LogHistoryBar(props: { palette: Palette; start: number; count: number; total: number }) {
  const end = Math.min(props.total, props.start + props.count);
  const older = Math.max(0, props.start);
  const newer = Math.max(0, props.total - end);
  return (
    <MetaBar
      palette={props.palette}
      items={[
        { text: `view ${props.start + 1}–${end} of ${props.total}`, tone: "primary" },
        { text: older > 0 ? `↑ ${older} older` : "start of history", tone: older > 0 ? "info" : "idle" },
        { text: newer > 0 ? `↓ ${newer} newer` : "at latest", tone: newer > 0 ? "warning" : "success" },
      ]}
      hints={[
        { key: "pgup/pgdn", label: "move history window" },
        { key: "g", label: "latest" },
      ]}
    />
  );
}
