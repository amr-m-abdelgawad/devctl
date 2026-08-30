import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { serviceLineState } from "../helpers.ts";
import { KeyHints, ScreenFrame, scrollboxStyle, Toolbar, useScrollSelectedIntoView } from "../layout.tsx";
import { serviceColor, stateColor, stateGlyph, type Palette } from "../themes.ts";
import { type DevctlConfig } from "../../config/index.ts";
import { type StatusSnapshot } from "../../types.ts";

const ROW_PREFIX = "profile-row";

export function ProfilesScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  profile: string;
  selected: number;
  onPick: (index: number) => void;
}) {
  const { palette, cfg, snap, profile, selected, onPick } = props;
  const scale = useDensity();
  const scrollRef = useScrollSelectedIntoView(selected, ROW_PREFIX);
  const keys = Object.keys(cfg?.profiles ?? {}).sort();
  if (keys.length === 0) {
    return <EmptyState palette={palette} title="No profiles" body="Add profiles.<name>.services in config.yaml." />;
  }
  return (
    <ScreenFrame palette={palette} title="profiles">
      <box height={1} flexShrink={0} overflow="hidden">
        <text fg={palette.muted} wrapMode="none">
          {`${keys.length} profile${keys.length === 1 ? "" : "s"}  ·  current: `}
          <span fg={palette.success}>{profile || "(none)"}</span>
        </text>
      </box>
      <box height={1} flexShrink={0} />
      <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
        <box flexDirection="column" overflow="hidden" gap={scale.gap || 1}>
          {keys.map((name, i) => {
            const isCurrent = name === profile;
            const isSelected = i === selected;
            const services = cfg?.profiles[name]?.services ?? [];
            const envCount = Object.keys(cfg?.profiles[name]?.environment ?? {}).length;
            const borderColor = isSelected ? palette.borderActive : isCurrent ? palette.success : palette.border;
            const titleColor = isSelected ? palette.primary : isCurrent ? palette.success : palette.muted;
            return (
              <box
                id={`${ROW_PREFIX}-${i}`}
                key={name}
                border
                borderStyle="rounded"
                borderColor={borderColor}
                title={name}
                titleColor={titleColor}
                flexDirection="column"
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                overflow="hidden"
                backgroundColor={isSelected ? palette.highlight : undefined}
                onMouseDown={() => onPick(i)}
              >
                <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
                  <text wrapMode="none">
                    {isCurrent ? <span fg={palette.success}>{"● current profile"}</span> : <span fg={palette.muted}>{"○ not active"}</span>}
                    <span fg={palette.muted}>{`  ·  ${services.length} service${services.length === 1 ? "" : "s"}`}</span>
                    {envCount > 0 ? <span fg={palette.muted}>{`  ·  ${envCount} env var${envCount === 1 ? "" : "s"}`}</span> : null}
                  </text>
                </box>
                <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
                  {services.length === 0 ? (
                    <text fg={palette.muted} wrapMode="none">
                      (no services)
                    </text>
                  ) : (
                    <text wrapMode="none">
                      {services.map((svcName, svcIndex) => {
                        const state = serviceLineState(snap?.services[svcName]);
                        return (
                          <span key={svcName}>
                            <span fg={stateColor(palette, state)}>{stateGlyph(state)}</span>
                            <span fg={serviceColor(svcName, palette)}>{` ${svcName}`}</span>
                            {svcIndex < services.length - 1 ? <span fg={palette.muted}>{"  "}</span> : null}
                          </span>
                        );
                      })}
                    </text>
                  )}
                </box>
              </box>
            );
          })}
        </box>
      </scrollbox>
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints palette={palette} hints={[{ key: "space", label: "set current" }, { key: "enter", label: "set and start" }]} />
      </Toolbar>
    </ScreenFrame>
  );
}
