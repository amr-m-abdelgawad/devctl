import { type Palette } from "../../themes.ts";

export function JumpLatestPrompt(props: { palette: Palette; width: number; newer: number; bottom?: number; onJump?: () => void }) {
  const label = props.newer > 0 ? `g  jump to latest  ·  ${props.newer} new` : "g  jump to latest";
  const promptWidth = Math.min(props.width, label.length + 4);
  return (
    <box
      position="absolute"
      left={Math.max(0, Math.floor((props.width - promptWidth) / 2))}
      bottom={props.bottom ?? 2}
      width={promptWidth}
      height={3}
      border
      borderStyle="rounded"
      borderColor={props.palette.warning}
      backgroundColor={props.palette.panel}
      alignItems="center"
      justifyContent="center"
      onMouseDown={props.onJump}
    >
      <text wrapMode="none">
        <span fg={props.palette.primary}>g</span>
        <span fg={props.palette.text}>{label.slice(1)}</span>
      </text>
    </box>
  );
}
