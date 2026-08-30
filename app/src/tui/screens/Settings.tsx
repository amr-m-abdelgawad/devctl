import { useDensity } from "../density.tsx";
import { clipText } from "../helpers.ts";
import { scrollboxStyle, useScrollSelectedIntoView } from "../layout.tsx";
import { groupedSettings, selectedSettingsItem, settingsIndex, sizeMeter, type SettingsItem, type UiScale } from "../settings.ts";
import { type Palette } from "../themes.ts";

const NAME_WIDTH = 14;
const KIND_WIDTH = 2;
const DETAIL_H = 5;
const ROW_PREFIX = "settings-row";

function kindGlyph(kind: SettingsItem["kind"]): string {
  switch (kind) {
    case "cycle":
      return "↔";
    case "toggle":
      return "⏻";
    case "page":
      return "▸";
    case "action":
      return "!";
    default:
      return "·";
  }
}

export function SettingsScreen(props: {
  palette: Palette;
  items: SettingsItem[];
  selected: number;
  locked: boolean;
  width: number;
  onPick: (index: number) => void;
  onActivate: (item: SettingsItem) => void;
}) {
  const { palette, items, selected, locked, width, onPick, onActivate } = props;
  const scale = useDensity();
  const active = settingsIndex(items, selected);
  const current = selectedSettingsItem(items, active);
  return (
    <box flexGrow={1} border borderStyle="rounded" borderColor={palette.borderActive} backgroundColor={palette.panel} title="settings" titleColor={palette.primary} flexDirection="column" overflow="hidden">
      <box height={2} paddingLeft={scale.pad} flexShrink={0} flexDirection="column" overflow="hidden">
        <text fg={palette.primary} wrapMode="none">
          Preferences
        </text>
        <text fg={palette.muted} wrapMode="none">
          {locked ? "DEVCTL_TUI_CONFIG is set — changes stay in this session." : "Changes save to your user tui.json unless noted."}
        </text>
      </box>
      <box flexGrow={1} paddingLeft={scale.pad} paddingRight={scale.pad} overflow="hidden" flexShrink={1}>
        <SettingsList palette={palette} items={items} active={active} scale={scale} width={width} onPick={onPick} onActivate={onActivate} />
      </box>
      <SettingsDetail palette={palette} item={current} scale={scale} />
    </box>
  );
}

function SettingsList(props: {
  palette: Palette;
  items: SettingsItem[];
  active: number;
  scale: UiScale;
  width: number;
  onPick: (index: number) => void;
  onActivate: (item: SettingsItem) => void;
}) {
  const { palette, items, active, scale, width, onPick, onActivate } = props;
  const scrollRef = useScrollSelectedIntoView(active, ROW_PREFIX);
  const valueWidth = Math.max(8, width - NAME_WIDTH - KIND_WIDTH - 10);
  let offset = 0;
  const sections = groupedSettings(items);
  return (
    <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
      <box flexDirection="column" overflow="hidden">
        {sections.map((section, sectionIndex) => {
          const start = offset;
          offset += section.items.length;
          const sectionActive = active >= start && active < start + section.items.length;
          return (
            <box
              key={section.group}
              border
              borderStyle="rounded"
              borderColor={sectionActive ? palette.borderActive : palette.border}
              title={`${section.group} (${section.items.length})`}
              titleColor={sectionActive ? palette.primary : palette.muted}
              flexDirection="column"
              flexShrink={0}
              marginBottom={sectionIndex < sections.length - 1 ? Math.max(1, scale.gap) : 0}
              paddingLeft={1}
              paddingRight={1}
              overflow="hidden"
            >
              {section.group === "MCP" ? (
                <box height={1} overflow="hidden">
                  <text fg={palette.muted} wrapMode="none">
                    {"dedicated page — also /mcp or /agent"}
                  </text>
                </box>
              ) : null}
              {section.items.map((item, local) => {
                const index = start + local;
                return (
                  <SettingsRow
                    key={item.id}
                    index={index}
                    palette={palette}
                    item={item}
                    active={index === active}
                    rowH={scale.rowH}
                    valueWidth={valueWidth}
                    onPick={() => onPick(index)}
                    onActivate={() => onActivate(item)}
                  />
                );
              })}
            </box>
          );
        })}
      </box>
    </scrollbox>
  );
}

function SettingsRow(props: {
  palette: Palette;
  index: number;
  item: SettingsItem;
  active: boolean;
  rowH: number;
  valueWidth: number;
  onPick: () => void;
  onActivate: () => void;
}) {
  const { palette, index, item, active, rowH, valueWidth, onPick, onActivate } = props;
  return (
    <box
      id={`${ROW_PREFIX}-${index}`}
      height={rowH}
      flexDirection="row"
      overflow="hidden"
      flexShrink={0}
      backgroundColor={active ? palette.highlight : undefined}
      onMouseDown={() => {
        if (active) {
          onActivate();
          return;
        }
        onPick();
      }}
    >
      <box width={2} flexShrink={0} overflow="hidden">
        <text fg={palette.primary}>{active ? "›" : " "}</text>
      </box>
      <box width={KIND_WIDTH} flexShrink={0} overflow="hidden">
        <text fg={active ? palette.primary : palette.muted}>{kindGlyph(item.kind)}</text>
      </box>
      <box width={NAME_WIDTH} flexShrink={0} overflow="hidden">
        <text fg={active ? palette.primary : palette.text} wrapMode="none">
          {item.name}
        </text>
      </box>
      <box flexGrow={1} overflow="hidden">
        <text fg={valueColor(palette, item, active)} wrapMode="none">
          {clipText(item.value, valueWidth)}
        </text>
      </box>
    </box>
  );
}

function SettingsDetail(props: { palette: Palette; item?: SettingsItem; scale: UiScale }) {
  const { palette, item, scale } = props;
  const showScale = item?.id === "font";
  const title = item?.kind === "page" ? `${item.name}  →  dedicated page` : item?.name ?? "";
  return (
    <box
      height={DETAIL_H}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={palette.border}
      title="selected"
      titleColor={palette.muted}
      backgroundColor={palette.element}
      paddingLeft={scale.pad}
      paddingRight={scale.pad}
      flexDirection="column"
      overflow="hidden"
    >
      <box height={1} overflow="hidden">
        <text fg={palette.primary} wrapMode="none">
          {showScale ? `${sizeMeter(scale.steps)}  ${scale.label}` : title}
        </text>
      </box>
      <box height={1} overflow="hidden">
        <text fg={palette.text} wrapMode="word">
          {item?.detail ?? ""}
        </text>
      </box>
      <box height={1} overflow="hidden">
        <text fg={palette.muted} wrapMode="none">
          {item ? (item.kind === "info" ? "read-only" : item.hint) : ""}
        </text>
      </box>
    </box>
  );
}

function valueColor(palette: Palette, item: SettingsItem, active: boolean): string {
  if (item.id === "mouse") {
    return item.value === "on" ? palette.success : palette.text;
  }
  if (item.kind === "page") {
    return palette.info;
  }
  if (item.kind === "info") {
    return palette.text;
  }
  return active ? palette.primary : palette.text;
}
