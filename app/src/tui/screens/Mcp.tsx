import { useDensity } from "../density.tsx";
import { Chip, KeyHints, MetaBar, ScreenFrame, scrollboxStyle, Toolbar } from "../layout.tsx";
import { agentColor, onAgentColor, type Palette } from "../themes.ts";
import { mcpSnippets, mcpUrl, type McpSnippet } from "../../mcp/snippets.ts";
import { type StatusSnapshot } from "../../types.ts";

export const MCP_TOGGLE_ROW = 0;
export const MCP_PORT_ROW = 1;
export const MCP_FIRST_SNIPPET = 2;
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
}) {
  const { palette, snap, port, portDraft = "", selected, onPick, onToggle, onCopy } = props;
  const scale = useDensity();
  const running = snap?.mcp?.running === true;
  const livePort = snap?.mcp?.port ?? port;
  const url = snap?.mcp?.address ?? mcpUrl(livePort);
  const token = snap?.mcp?.token ?? "";
  const snippets = mcpSnippets(url, token);
  const selectedSnippet = snippets[selected - MCP_FIRST_SNIPPET];
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
            <SectionTitle palette={palette} text="Copy agent config" extra="highlight a row, then enter or click Copy" />
            {snippets.map((snippet, index) => {
              const row = MCP_FIRST_SNIPPET + index;
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
