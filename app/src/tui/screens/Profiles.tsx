import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { KeyHints, ScreenFrame, scrollboxStyle, Toolbar, useScrollSelectedIntoView } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type DevctlConfig } from "../../config/index.ts";

const ROW_PREFIX = "profile-row";
const NAME_COL = 16;
const CURRENT_COL = 12;

export function ProfilesScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  profile: string;
  selected: number;
  onPick: (index: number) => void;
}) {
  const { palette, cfg, profile, selected, onPick } = props;
  const scale = useDensity();
  const scrollRef = useScrollSelectedIntoView(selected, ROW_PREFIX);
  const keys = Object.keys(cfg?.profiles ?? {}).sort();
  if (keys.length === 0) {
    return <EmptyState palette={palette} title="No profiles" body="Add profiles.<name>.services in config.yaml." />;
  }
  return (
    <ScreenFrame palette={palette} title="profiles">
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden">
          {keys.map((name, i) => (
            <box
              id={`${ROW_PREFIX}-${i}`}
              key={name}
              height={scale.rowH}
              flexDirection="row"
              overflow="hidden"
              backgroundColor={i === selected ? palette.highlight : undefined}
              onMouseDown={() => onPick(i)}
            >
              <box width={2} flexShrink={0}>
                <text fg={palette.accent}>{i === selected ? "›" : " "}</text>
              </box>
              <box width={NAME_COL} flexShrink={0} overflow="hidden">
                <text fg={i === selected ? palette.primary : palette.text}>{name}</text>
              </box>
              <box width={CURRENT_COL} flexShrink={0} overflow="hidden">
                <text fg={name === profile ? palette.success : palette.muted}>{name === profile ? "current" : ""}</text>
              </box>
              <box flexGrow={1} overflow="hidden">
                <text fg={palette.text} wrapMode="none">
                  {cfg?.profiles[name]?.services.join(", ") ?? ""}
                </text>
              </box>
            </box>
          ))}
        </box>
      </scrollbox>
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints palette={palette} hints={[{ key: "enter", label: "use this profile and start it" }]} />
      </Toolbar>
    </ScreenFrame>
  );
}
