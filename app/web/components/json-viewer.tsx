import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { CaretDownIcon, CaretRightIcon, CheckIcon, CodeIcon, CopyIcon, TreeStructureIcon } from "../icons.ts";
import {
  coerceJsonInput,
  formatJsonPath,
  initialCollapsedIds,
  JSON_FIND_MIN,
  prettyJson,
  tokenizeJson,
  visibleJsonTree,
  type JsonPathSegment,
  type JsonTokenKind,
  type JsonTreeNode,
  type JsonType,
} from "../json-view.ts";
import { cn } from "../lib/utils.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

const COPY_FEEDBACK_MS = 2_000;
const VIEW_KEY = "devctl.json.viewMode";

type ViewMode = "tree" | "pretty";

function readViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "pretty" ? "pretty" : "tree";
  } catch {
    return "tree";
  }
}

function persistViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_KEY, mode);
  } catch {
    return;
  }
}

export function JsonViewer(props: {
  title?: string;
  input: unknown;
  needle?: string;
  wrap?: boolean;
  className?: string;
}) {
  const { title, input, needle = "", wrap = true, className } = props;
  const coerced = useMemo(() => coerceJsonInput(input), [input]);
  const [view, setView] = useState<ViewMode>(readViewMode);
  const [collapsed, setCollapsed] = useState(() => initialCollapsedIds(input));
  const [selected, setSelected] = useState<readonly JsonPathSegment[]>([]);
  useEffect(() => {
    setCollapsed(initialCollapsedIds(input));
    setSelected([]);
  }, [input]);
  const rows = useMemo(
    () => visibleJsonTree(input, { collapsed, needle }),
    [input, collapsed, needle],
  );
  const selectedId = formatJsonPath(selected);
  const selectedRow = rows.find((row) => row.id === selectedId);
  const search = needle.trim();
  const matched = search.length < JSON_FIND_MIN || coerced.pretty.toLowerCase().includes(search.toLowerCase()) || rows.some((row) => row.matched);
  const onView = (mode: ViewMode): void => {
    setView(mode);
    persistViewMode(mode);
  };
  if (coerced.pretty === "") {
    return (
      <div className={cn("min-w-0", className)}>
        {title ? <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3> : null}
        <p className="text-xs text-muted-foreground">empty</p>
      </div>
    );
  }
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col gap-1.5", matched ? "" : "opacity-40", className)}>
      <Toolbar
        title={title}
        kind={coerced.kind}
        view={view}
        onView={onView}
        pretty={coerced.pretty}
        onExpandAll={() => setCollapsed(new Set())}
        onCollapseAll={() => setCollapsed(initialCollapsedIds(input, 0))}
      />
      {coerced.kind === "json" ? (
        <PathBar row={selectedRow} fallback={selected} />
      ) : null}
      {view === "pretty" || coerced.kind !== "json" ? (
        <PrettyPane pretty={coerced.pretty} wrap={wrap} needle={search} />
      ) : (
        <TreePane
          rows={rows}
          selectedId={selectedId}
          collapsed={collapsed}
          onSelect={setSelected}
          onToggle={(id) => setCollapsed((current) => toggleId(current, id))}
          onSetCollapsed={(id, nextCollapsed) => setCollapsed((current) => setCollapsedId(current, id, nextCollapsed))}
        />
      )}
    </div>
  );
}

function Toolbar(props: {
  title?: string;
  kind: "json" | "text";
  view: ViewMode;
  onView: (mode: ViewMode) => void;
  pretty: string;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const { title, kind, view, onView, pretty, onExpandAll, onCollapseAll } = props;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {title ? <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3> : null}
        <Badge variant="outline">{kind === "json" ? "json" : "text"}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {kind === "json" ? (
          <>
            <div className="inline-flex rounded-md border border-border/70 bg-muted/40 p-0.5">
              <ModeTab label="Tree" icon={<TreeStructureIcon className="size-3" />} active={view === "tree"} onClick={() => onView("tree")} />
              <ModeTab label="Pretty" icon={<CodeIcon className="size-3" />} active={view === "pretty"} onClick={() => onView("pretty")} />
            </div>
            {view === "tree" ? (
              <>
                <Button type="button" size="xs" variant="ghost" onClick={onExpandAll}>Expand</Button>
                <Button type="button" size="xs" variant="ghost" onClick={onCollapseAll}>Collapse</Button>
              </>
            ) : null}
          </>
        ) : null}
        <CopyTextButton text={pretty} label="Copy" />
      </div>
    </div>
  );
}

function ModeTab(props: { label: string; icon: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
        props.active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

function PathBar(props: { row?: JsonTreeNode; fallback: readonly JsonPathSegment[] }) {
  const { row, fallback } = props;
  const path = row?.pathLabel ?? formatJsonPath(fallback);
  const value = row ? copyValue(row) : "";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1">
      <span className="font-mono text-[11px] text-primary/90" title={path}>{path}</span>
      {row ? <Badge variant="muted">{row.type}{row.expandable ? ` ${row.childCount}` : ""}</Badge> : null}
      <div className="ml-auto flex items-center gap-1">
        <CopyTextButton text={path} label="Path" />
        <CopyTextButton text={value} label="Value" />
      </div>
    </div>
  );
}

function TreePane(props: {
  rows: JsonTreeNode[];
  selectedId: string;
  collapsed: ReadonlySet<string>;
  onSelect: (path: readonly JsonPathSegment[]) => void;
  onToggle: (id: string) => void;
  onSetCollapsed: (id: string, nextCollapsed: boolean) => void;
}) {
  const { rows, selectedId, collapsed, onSelect, onToggle, onSetCollapsed } = props;
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = Math.max(0, rows.findIndex((row) => row.id === selectedId));
    const current = rows[index];
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      const next = rows[Math.min(rows.length - 1, index + 1)];
      if (next) {
        onSelect(next.path);
      }
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      const prev = rows[Math.max(0, index - 1)];
      if (prev) {
        onSelect(prev.path);
      }
    } else if ((event.key === "ArrowRight" || event.key === "l") && current?.expandable) {
      event.preventDefault();
      onSetCollapsed(current.id, false);
    } else if ((event.key === "ArrowLeft" || event.key === "h") && current?.expandable) {
      event.preventDefault();
      onSetCollapsed(current.id, true);
    } else if (event.key === "Enter" && current?.expandable) {
      event.preventDefault();
      onToggle(current.id);
    }
  };
  return (
    <div
      role="tree"
      tabIndex={0}
      onKeyDown={onKey}
      className="json-tree max-h-[min(40rem,70vh)] overflow-auto rounded-md bg-muted/40 px-1.5 py-1.5 font-mono text-[12px] leading-6 outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {rows.map((row) => (
        <TreeRow
          key={row.id}
          row={row}
          selected={row.id === selectedId}
          collapsed={collapsed.has(row.id)}
          onSelect={() => onSelect(row.path)}
          onToggle={() => onToggle(row.id)}
        />
      ))}
    </div>
  );
}

function TreeRow(props: {
  row: JsonTreeNode;
  selected: boolean;
  collapsed: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { row, selected, collapsed, onSelect, onToggle } = props;
  return (
    <div
      role="treeitem"
      aria-expanded={row.expandable ? !collapsed : undefined}
      aria-selected={selected}
      style={{ paddingLeft: `${row.depth * 1.1}rem` }}
      className={cn(
        "flex cursor-pointer items-start gap-1 rounded-sm px-1",
        selected ? "bg-primary/12" : "hover:bg-accent/50",
        row.matched ? "json-row-match" : "",
      )}
      onClick={onSelect}
    >
      <button
        type="button"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        onClick={(event) => {
          event.stopPropagation();
          if (row.expandable) {
            onToggle();
          }
        }}
        aria-label={row.expandable ? "Toggle node" : "Leaf"}
      >
        {row.expandable ? (collapsed ? <CaretRightIcon className="size-3" /> : <CaretDownIcon className="size-3" />) : <span className="inline-block size-3" />}
      </button>
      {row.depth === 0 ? null : <span className="json-key">{row.key}</span>}
      {row.depth === 0 ? null : <span className="json-punct">:</span>}
      {row.expandable ? (
        <span className="text-muted-foreground">{row.type === "array" ? `[${row.childCount}]` : `{${row.childCount}}`}</span>
      ) : (
        <span className={typeClass(row.type)}>{row.preview}</span>
      )}
    </div>
  );
}

function PrettyPane(props: { pretty: string; wrap: boolean; needle: string }) {
  const { pretty, wrap, needle } = props;
  const tokens = tokenizeJson(pretty);
  return (
    <pre
      className={cn(
        "json-pretty max-h-[min(40rem,70vh)] overflow-auto rounded-md bg-muted/40 p-2.5 font-mono text-[12px] leading-6 text-foreground/90",
        wrap ? "whitespace-pre-wrap break-all" : "overflow-x-auto whitespace-pre",
      )}
    >
      {tokens.map((token, index) => (
        <span key={`${token.kind}-${index}`} className={tokenClass(token.kind)}>
          {highlight(token.text, needle)}
        </span>
      ))}
    </pre>
  );
}

export function CopyTextButton(props: { text: string; label?: string }) {
  const { text, label } = props;
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    if (text === "") {
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    }).catch(() => {
      setCopied(false);
    });
  };
  return (
    <Button type="button" size="xs" variant="ghost" className="h-6 gap-1 px-1.5 text-muted-foreground" onClick={copy} disabled={text === ""}>
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {label ? <span>{copied ? "Copied" : label}</span> : null}
    </Button>
  );
}

function copyValue(row: JsonTreeNode): string {
  if (row.type === "string" && typeof row.value === "string") {
    return row.value;
  }
  return prettyJson(row.value);
}

function toggleId(current: ReadonlySet<string>, id: string): Set<string> {
  return setCollapsedId(current, id, !current.has(id));
}

function setCollapsedId(current: ReadonlySet<string>, id: string, nextCollapsed: boolean): Set<string> {
  const next = new Set(current);
  if (nextCollapsed) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

function tokenClass(kind: JsonTokenKind): string {
  if (kind === "key") {
    return "json-key";
  }
  if (kind === "string") {
    return "json-string";
  }
  if (kind === "number") {
    return "json-number";
  }
  if (kind === "boolean") {
    return "json-boolean";
  }
  if (kind === "null") {
    return "json-null";
  }
  if (kind === "punct") {
    return "json-punct";
  }
  return "";
}

function typeClass(type: JsonType): string {
  if (type === "string") {
    return "json-string";
  }
  if (type === "number") {
    return "json-number";
  }
  if (type === "boolean") {
    return "json-boolean";
  }
  if (type === "null") {
    return "json-null";
  }
  return "text-foreground";
}

function highlight(text: string, needle: string): ReactNode {
  if (needle.length < JSON_FIND_MIN) {
    return text;
  }
  const lower = text.toLowerCase();
  const find = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  let index = lower.indexOf(find);
  let key = 0;
  while (index !== -1) {
    if (index > start) {
      parts.push(text.slice(start, index));
    }
    parts.push(<mark key={key} className="rounded-sm bg-warning/40 text-foreground">{text.slice(index, index + needle.length)}</mark>);
    start = index + needle.length;
    index = lower.indexOf(find, start);
    key += 1;
  }
  parts.push(text.slice(start));
  return parts;
}
