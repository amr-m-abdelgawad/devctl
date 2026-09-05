import { type CommandSpec } from "../commands.ts";
import { selectedSlashCommand, slashWindowStart } from "../helpers.ts";
import { type Palette } from "../themes.ts";

const VISIBLE = 8;

export function SlashOverlay(props: {
  palette: Palette;
  items: CommandSpec[];
  query: string;
  selected: number;
  onQuery: (value: string) => void;
  onSubmit: () => void;
}) {
  const { palette, items, query, selected, onQuery, onSubmit } = props;
  const start = slashWindowStart(selected, VISIBLE, items.length);
  const shown = items.slice(start, start + VISIBLE);
  const rows = Math.max(shown.length, 1);
  const active = selectedSlashCommand(items, selected);
  return (
    <box
      height={rows + 3}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={palette.borderActive}
      titleColor={palette.primary}
      backgroundColor={palette.panel}
      title="commands"
      flexDirection="column"
      overflow="hidden"
    >
      {shown.length === 0 ? (
        <box height={1} paddingLeft={1} overflow="hidden">
          <text fg={palette.muted}>no matching command</text>
        </box>
      ) : (
        shown.map((cmd) => {
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
            placeholder="start auth"
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
