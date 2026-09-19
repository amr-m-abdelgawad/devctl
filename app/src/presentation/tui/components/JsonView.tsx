import { type ReactNode, useEffect, useState } from "react";
import {
  coerceJsonInput,
  initialCollapsedIds,
  JSON_DEFAULT_EXPAND_DEPTH,
  tokenizeJson,
  visibleJsonTree,
  type JsonTokenKind,
  type JsonTreeNode,
  type JsonType,
} from "../../../shared/json-view.ts";
import { type Palette } from "../themes.ts";

export function JsonView(props: {
  palette: Palette;
  input: unknown;
  compact?: boolean;
  maxChars?: number;
  parseStrings?: boolean;
}) {
  const { palette, input, compact = false, maxChars, parseStrings = true } = props;
  const coerced = coerceJsonInput(input, parseStrings);
  if (coerced.pretty === "") {
    return <text fg={palette.muted}>{"empty"}</text>;
  }
  if (coerced.kind !== "json") {
    return <WrappedText palette={palette}>{clipPretty(coerced.pretty, compact ? maxChars : undefined)}</WrappedText>;
  }
  if (compact) {
    return <JsonPretty palette={palette} pretty={clipPretty(coerced.pretty, maxChars)} />;
  }
  return <JsonTree palette={palette} input={coerced.value} signature={coerced.pretty} />;
}

function WrappedText(props: { palette: Palette; children: ReactNode; onMouseDown?: () => void }) {
  const { palette, children, onMouseDown } = props;
  return (
    <box minWidth={0} width="100%" overflow="hidden">
      <text fg={palette.text} wrapMode="char" flexShrink={0} width="100%" onMouseDown={onMouseDown}>
        {children}
      </text>
    </box>
  );
}

function JsonPretty(props: { palette: Palette; pretty: string }) {
  const { palette, pretty } = props;
  return (
    <WrappedText palette={palette}>
      {tokenizeJson(pretty).map((token, index) => (
        <span key={`${token.kind}-${index}`} fg={jsonTokenColor(palette, token.kind)}>
          {token.text}
        </span>
      ))}
    </WrappedText>
  );
}

function JsonTree(props: { palette: Palette; input: unknown; signature: string }) {
  const { palette, input, signature } = props;
  const [collapsed, setCollapsed] = useState(() => initialCollapsedIds(input, JSON_DEFAULT_EXPAND_DEPTH));
  useEffect(() => {
    setCollapsed(initialCollapsedIds(input, JSON_DEFAULT_EXPAND_DEPTH));
  }, [signature]);
  const rows = visibleJsonTree(input, { collapsed });
  return (
    <box flexDirection="column" minWidth={0} width="100%" overflow="hidden">
      {rows.map((row) => (
        <JsonTreeRow
          key={row.id}
          palette={palette}
          row={row}
          collapsed={collapsed.has(row.id)}
          onToggle={() => setCollapsed((current) => toggleId(current, row.id))}
        />
      ))}
    </box>
  );
}

function JsonTreeRow(props: {
  palette: Palette;
  row: JsonTreeNode;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { palette, row, collapsed, onToggle } = props;
  const indent = "  ".repeat(row.depth);
  const caret = row.expandable ? (collapsed ? "▸ " : "▾ ") : "  ";
  return (
    <WrappedText palette={palette} onMouseDown={row.expandable ? onToggle : undefined}>
      <span fg={palette.muted}>{indent + caret}</span>
      {row.depth === 0 ? null : (
        <>
          <span fg={palette.primary}>{row.key}</span>
          <span fg={palette.muted}>{": "}</span>
        </>
      )}
      {row.expandable ? (
        <span fg={palette.muted}>{typePreview(row)}</span>
      ) : (
        <span fg={jsonTypeColor(palette, row.type)}>{row.preview}</span>
      )}
    </WrappedText>
  );
}

function toggleId(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

function clipPretty(pretty: string, maxChars?: number): string {
  if (maxChars === undefined || pretty.length <= maxChars) {
    return pretty;
  }
  return `${pretty.slice(0, Math.max(1, maxChars - 1))}…`;
}

function typePreview(row: JsonTreeNode): string {
  if (row.type === "array") {
    return `[${row.childCount}]`;
  }
  if (row.type === "object") {
    return `{${row.childCount}}`;
  }
  return row.preview;
}

function jsonTokenColor(palette: Palette, kind: JsonTokenKind): string {
  if (kind === "key") {
    return palette.primary;
  }
  if (kind === "string") {
    return palette.accent;
  }
  if (kind === "number") {
    return palette.info;
  }
  if (kind === "boolean") {
    return palette.warning;
  }
  if (kind === "null" || kind === "punct") {
    return palette.muted;
  }
  return palette.text;
}

function jsonTypeColor(palette: Palette, type: JsonType): string {
  if (type === "string") {
    return palette.accent;
  }
  if (type === "number") {
    return palette.info;
  }
  if (type === "boolean") {
    return palette.warning;
  }
  if (type === "null") {
    return palette.muted;
  }
  return palette.text;
}
