import { useDensity } from "../density.tsx";
import { Chip, KeyHints, MetaBar, ScreenFrame, scrollboxStyle, Toolbar } from "../layout.tsx";
import { agentColor, onAgentColor, type Palette } from "../themes.ts";
import { mcpSnippets, mcpUrl, type McpSnippet } from "../../mcp/snippets.ts";
import { MCP_TOOL_CATEGORIES, MCP_TOOLS, toolEnabled, type McpToolDef } from "../../mcp/tools.ts";
import { type StatusSnapshot } from "../../types.ts";

export const MCP_TOGGLE_ROW = 0;
export const MCP_PORT_ROW = 1;
// Tools sit with the other settings, directly under Server — the snippets
// below them are output you copy once, not something you tune. That makes the
// snippet block's first row depend on how many tools exist, so it is derived
// rather than a constant: mcpSnippetIndexAtRow() is the only correct way to
// map a cursor row to a snippet.
export const MCP_FIRST_TOOL = 2;
export const MCP_SNIPPET_COUNT = 4;

const CATEGORY_LABELS: Record<string, string> = {
  inspect: "Inspect",
  logs: "Logs",
  diagnostics: "Diagnostics",
  control: "Control",
  setup: "Setup",
};

// The screen's row order for tools: grouped by category, in MCP_TOOL_CATEGORIES
// order. Exported so App.tsx maps a cursor row to the same tool this renders.
export function mcpToolRows(): readonly McpToolDef[] {
  return MCP_TOOL_CATEGORIES.flatMap((category) => MCP_TOOLS.filter((tool) => tool.category === category));
}

export function mcpFirstSnippetRow(): number {
  return MCP_FIRST_TOOL + mcpToolRows().length;
}

export function mcpRowCount(): number {
  return mcpFirstSnippetRow() + MCP_SNIPPET_COUNT;
}

export function mcpToolAtRow(row: number): McpToolDef | undefined {
  if (row < MCP_FIRST_TOOL || row >= mcpFirstSnippetRow()) {
    return undefined;
  }
  return mcpToolRows()[row - MCP_FIRST_TOOL];
}

export function mcpSnippetIndexAtRow(row: number): number | undefined {
  const index = row - mcpFirstSnippetRow();
  return index >= 0 && index < MCP_SNIPPET_COUNT ? index : undefined;
}
const LABEL_WIDTH = 14;
const VALUE_WIDTH = 14;

export function McpScreen(props: {
  palette: Palette;
  snap?: StatusSnapshot;
  port: number;
  portDraft?: string;
  selected: number;
  onPick: (index: number) => void;
  onToggle: () => void;
  onCopy: (snippet: McpSnippet) => void;
  onToggleTool: (tool: McpToolDef) => void;
}) {
  const { palette, snap, port, portDraft = "", selected, onPick, onToggle, onCopy, onToggleTool } = props;
  const scale = useDensity();
  const running = snap?.mcp?.running === true;
  const livePort = snap?.mcp?.port ?? port;
  const url = snap?.mcp?.address ?? mcpUrl(livePort);
  const token = snap?.mcp?.token ?? "";
  const snippets = mcpSnippets(url, token);
  const disabled = snap?.mcp?.disabled_tools ?? [];
  const tools = mcpToolRows();
  const offCount = tools.filter((tool) => !toolEnabled(tool.name, disabled)).length;
  const selectedSnippet = snippets[mcpSnippetIndexAtRow(selected) ?? -1];
  const preview = selectedSnippet ?? snippets[0];
  return (
    <ScreenFrame palette={palette} title="mcp settings">
      <MetaBar
        palette={palette}
        items={[
          { text: running ? "RUNNING" : "STOPPED", tone: running ? "success" : "idle" },
          { text: `127.0.0.1:${livePort}`, tone: "info" },
        ]}
      />
      <box flexGrow={1} overflow="hidden">
        <scrollbox focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
          <box flexDirection="column" overflow="hidden">
            <SectionTitle palette={palette} text="Server" />
            <ControlRow
              palette={palette}
              active={selected === MCP_TOGGLE_ROW}
              rowH={scale.rowH}
              label="Listen"
              value={running ? "[  ON   ]" : "[  OFF  ]"}
              valueTone={running ? "success" : "muted"}
              hint={running ? "space or enter  stop" : "space or enter  start"}
              onPick={() => onPick(MCP_TOGGLE_ROW)}
              onActivate={onToggle}
            />
            <ControlRow
              palette={palette}
              active={selected === MCP_PORT_ROW}
              rowH={scale.rowH}
              label="Port"
              value={`‹ ${portDraft === "" ? port : portDraft} ›`}
              valueTone="info"
              hint={portDraft === "" ? "← → change   type digits   enter apply" : "typing…  enter apply  ⌫ erase"}
              onPick={() => onPick(MCP_PORT_ROW)}
            />
            <box height={1} overflow="hidden">
              <text fg={palette.muted} wrapMode="none">
                {running
                  ? "Listening on loopback. Agents use the URL and token in the JSON below."
                  : "Server is stopped. Highlight Listen and press space to start it."}
              </text>
            </box>
            <SectionTitle
              palette={palette}
              text="Tools"
              extra={offCount === 0 ? "all enabled" : `${offCount} disabled`}
            />
            <box height={1} overflow="hidden">
              <text fg={palette.muted} wrapMode="none">
                Disabled tools are hidden from agents and refused if called anyway.
              </text>
            </box>
            {MCP_TOOL_CATEGORIES.map((category) => {
              const group = tools.filter((tool) => tool.category === category);
              if (group.length === 0) {
                return null;
              }
              return (
                <box key={category} flexDirection="column" overflow="hidden">
                  <box height={1} marginTop={1} overflow="hidden">
                    <text fg={palette.muted} wrapMode="none">
                      {CATEGORY_LABELS[category] ?? category}
                    </text>
                  </box>
                  {group.map((tool) => {
                    const row = MCP_FIRST_TOOL + tools.indexOf(tool);
                    return (
                      <ToolRow
                        key={tool.name}
                        palette={palette}
                        tool={tool}
                        enabled={toolEnabled(tool.name, disabled)}
                        active={selected === row}
                        rowH={scale.rowH}
                        onPick={() => onPick(row)}
                        onToggle={() => onToggleTool(tool)}
                      />
                    );
                  })}
                </box>
              );
            })}
            <SectionTitle palette={palette} text="Copy agent config" extra="highlight a row, then enter or click Copy" />
            {snippets.map((snippet, index) => {
              const row = mcpFirstSnippetRow() + index;
              return (
                <SnippetRow
                  key={snippet.kind}
                  palette={palette}
                  snippet={snippet}
                  active={selected === row}
                  rowH={scale.rowH}
                  onPick={() => onPick(row)}
                  onCopy={() => onCopy(snippet)}
                />
              );
            })}
            <SnippetPreview
              palette={palette}
              snippet={preview}
              selected={Boolean(selectedSnippet)}
              brand={preview ? agentColor(preview.kind, palette) : palette.muted}
            />
          </box>
        </scrollbox>
      </box>
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints palette={palette} hints={mcpHints(selected, running)} />
      </Toolbar>
    </ScreenFrame>
  );
}

export function mcpHints(selected: number, running: boolean): Array<{ key: string; label: string }> {
  if (selected === MCP_TOGGLE_ROW) {
    return [
      { key: "space", label: running ? "stop server" : "start server" },
      { key: "j/k", label: "move" },
    ];
  }
  if (selected === MCP_PORT_ROW) {
    return [
      { key: "←→", label: "change port" },
      { key: "0-9", label: "type port" },
      { key: "enter", label: "apply port" },
      { key: "j/k", label: "move" },
    ];
  }
  // Ask the row model, not `>= MCP_FIRST_TOOL`: snippet rows sit past the
  // tool rows now, so a bare lower bound would claim they toggle a tool.
  if (mcpToolAtRow(selected)) {
    return [
      { key: "space", label: "enable / disable" },
      { key: "enter", label: "enable / disable" },
      { key: "j/k", label: "move" },
    ];
  }
  return [
    { key: "enter", label: "copy JSON" },
    { key: "space", label: "copy JSON" },
    { key: "j/k", label: "move" },
  ];
}

function SectionTitle(props: { palette: Palette; text: string; extra?: string }) {
  const extra = props.extra ? `  ·  ${props.extra}` : "";
  return (
    <box height={1} marginTop={1} overflow="hidden">
      <text wrapMode="none">
        <span fg={props.palette.primary}>{props.text}</span>
        <span fg={props.palette.muted}>{extra}</span>
      </text>
    </box>
  );
}

function ControlRow(props: {
  palette: Palette;
  active: boolean;
  rowH: number;
  label: string;
  value: string;
  valueTone: "success" | "info" | "muted";
  hint: string;
  onPick: () => void;
  onActivate?: () => void;
}) {
  const { palette, active, rowH, label, value, valueTone, hint, onPick, onActivate } = props;
  const valueFg = valueTone === "success" ? palette.success : valueTone === "info" ? palette.info : palette.muted;
  return (
    <box
      height={rowH}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={active ? palette.highlight : palette.panel}
      onMouseDown={() => {
        if (active && onActivate) {
          onActivate();
          return;
        }
        onPick();
      }}
    >
      <box width={2} flexShrink={0} overflow="hidden">
        <text fg={palette.primary}>{active ? "›" : " "}</text>
      </box>
      <box width={LABEL_WIDTH} flexShrink={0} overflow="hidden">
        <text fg={active ? palette.primary : palette.text} wrapMode="none">
          {label}
        </text>
      </box>
      <box width={VALUE_WIDTH} flexShrink={0} overflow="hidden">
        <text fg={valueFg} wrapMode="none">
          {value}
        </text>
      </box>
      <box flexGrow={1} overflow="hidden">
        <text fg={active ? palette.text : palette.muted} wrapMode="none">
          {hint}
        </text>
      </box>
    </box>
  );
}

function SnippetRow(props: {
  palette: Palette;
  snippet: McpSnippet;
  active: boolean;
  rowH: number;
  onPick: () => void;
  onCopy: () => void;
}) {
  const { palette, snippet, active, rowH, onPick, onCopy } = props;
  const brand = agentColor(snippet.kind, palette);
  const onBrand = onAgentColor(snippet.kind, palette);
  const copyLabel = snippet.language === "toml" ? "Copy TOML" : "Copy JSON";
  return (
    <box
      height={rowH}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={active ? palette.highlight : palette.panel}
      onMouseDown={onPick}
    >
      <box width={2} flexShrink={0} overflow="hidden">
        <text fg={brand}>{active ? "›" : " "}</text>
      </box>
      <box width={LABEL_WIDTH} flexShrink={0} overflow="hidden">
        <text fg={brand} wrapMode="none">
          {snippet.title}
        </text>
      </box>
      <box flexGrow={1} overflow="hidden">
        <text fg={palette.muted} wrapMode="none">
          {snippet.path}
        </text>
      </box>
      <Chip
        palette={palette}
        label={copyLabel}
        bg={brand}
        fg={onBrand}
        onMouseDown={() => {
          onPick();
          onCopy();
        }}
      />
    </box>
  );
}

function ToolRow(props: {
  palette: Palette;
  tool: McpToolDef;
  enabled: boolean;
  active: boolean;
  rowH: number;
  onPick: () => void;
  onToggle: () => void;
}) {
  const { palette, tool, enabled, active, rowH, onPick, onToggle } = props;
  // Same focus treatment as ControlRow and SnippetRow: highlight background
  // plus a "›" gutter. A row that only changed its background was too easy to
  // lose among thirteen near-identical lines.
  return (
    <box
      height={rowH}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={active ? palette.highlight : palette.panel}
      onMouseDown={() => {
        if (active) {
          onToggle();
          return;
        }
        onPick();
      }}
    >
      <box width={2} flexShrink={0} overflow="hidden">
        <text fg={palette.primary}>{active ? "›" : " "}</text>
      </box>
      <box width={5} flexShrink={0} overflow="hidden">
        <text fg={enabled ? palette.success : palette.muted} wrapMode="none">
          {enabled ? " ON  " : " OFF "}
        </text>
      </box>
      <box width={LABEL_WIDTH + 4} flexShrink={0} overflow="hidden">
        <text fg={active ? palette.primary : enabled ? palette.text : palette.muted} wrapMode="none">
          {tool.label}
        </text>
      </box>
      <box width={7} flexShrink={0} overflow="hidden">
        <text fg={tool.mutates ? palette.warning : palette.muted} wrapMode="none">
          {tool.mutates ? "write" : "read"}
        </text>
      </box>
      <box flexGrow={1} overflow="hidden">
        {/* The focused row trades its description for what pressing space
            will actually do, so the action is never ambiguous. */}
        <text fg={active ? palette.text : palette.muted} wrapMode="none">
          {active ? `space or enter  ${enabled ? "disable" : "enable"} ${tool.name}` : tool.summary}
        </text>
      </box>
    </box>
  );
}

function SnippetPreview(props: { palette: Palette; snippet?: McpSnippet; selected: boolean; brand: string }) {
  const { palette, snippet, selected, brand } = props;
  if (!snippet) {
    return null;
  }
  const hint = snippet.hint ? `  ·  ${snippet.hint}` : "";
  return (
    <box marginTop={1} flexDirection="column" overflow="hidden">
      <text fg={brand} wrapMode="none">
        {selected ? `${snippet.title}  ·  paste into ${snippet.path}${hint}` : `Preview  ${snippet.title}  ·  j/k to a copy row, then enter`}
      </text>
      <text fg={palette.text}>{snippet.text}</text>
    </box>
  );
}
