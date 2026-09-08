import { commandSearchToken, type CommandSpec } from "../commands.ts";
import { groupedCommands, selectedSlashCommand, slashWindowItems, slashWindowStart } from "../helpers/command-catalog.ts";
import { type Palette } from "../themes.ts";

const MAX_VISUAL_ROWS = 10;
const CHROME_ROWS = 3;

export function SlashOverlay(props: {
  palette: Palette;
  items: CommandSpec[];
  query: string;
  selected: number;
  onQuery: (value: string) => void;
  onSubmit: () => void;
  title?: string;
}) {
  const { palette, items, query, selected, onQuery, onSubmit, title = "commands" } = props;
  const searching = commandSearchToken(query) !== "";
  const start = slashWindowStart(selected, MAX_VISUAL_ROWS, items.length);
  const shown = searching ? items.slice(start, start + MAX_VISUAL_ROWS) : slashWindowItems(items, selected, MAX_VISUAL_ROWS);
  const groups = searching ? [{ group: "", items: shown }] : groupedCommands(shown);
  const rows = Math.max(shown.length + (searching ? 0 : groups.length), 1);
  const active = selectedSlashCommand(items, selected);
  return (
    <box
      height={rows + CHROME_ROWS}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={palette.borderActive}
      titleColor={palette.primary}
      backgroundColor={palette.panel}
      title={title}
      flexDirection="column"
      overflow="hidden"
    >
      {shown.length === 0 ? (
        <box height={1} paddingLeft={1} overflow="hidden">
          <text fg={palette.muted}>no matching command</text>
        </box>
      ) : (
        groups.flatMap((group) => {
          const header =
            group.group === ""
              ? []
              : [
                  <box key={`g-${group.group}`} height={1} paddingLeft={1} overflow="hidden" backgroundColor={palette.panel}>
                    <text fg={palette.muted} wrapMode="none">
                      {group.group}
                    </text>
                  </box>,
                ];
          return [
            ...header,
            ...group.items.map((cmd) => {
              const activeRow = cmd.name === active?.name;
              return (
                <box
                  key={cmd.name}
                  height={1}
                  flexDirection="row"
                  overflow="hidden"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={activeRow ? palette.highlight : palette.panel}
                >
                  <box width={14} flexShrink={0} overflow="hidden">
                    <text fg={activeRow ? palette.primary : palette.text} wrapMode="none">
                      {`${activeRow ? "›" : " "} /${cmd.name}`}
                    </text>
                  </box>
                  <box flexGrow={1} overflow="hidden">
                    <text fg={activeRow ? palette.accent : palette.muted} wrapMode="none">
                      {cmd.desc}
                    </text>
                  </box>
                </box>
              );
            }),
          ];
        })
      )}
      <box height={1} flexDirection="row" overflow="hidden" backgroundColor={palette.highlight} paddingLeft={1}>
        <box width={2} flexShrink={0}>
          <text fg={palette.primary}>/</text>
        </box>
        <box flexGrow={1} overflow="hidden">
          <input
            focused
            value={query}
            placeholder="start  logs  settings"
            onInput={onQuery}
            onSubmit={() => onSubmit()}
            backgroundColor={palette.highlight}
            focusedBackgroundColor={palette.highlight}
            textColor={palette.text}
            cursorColor={palette.primary}
          />
        </box>
      </box>
    </box>
  );
}
