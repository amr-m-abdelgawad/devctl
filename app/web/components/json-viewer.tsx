import { useId, useLayoutEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

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
  parseStrings?: boolean;
  resetKey?: string;
}) {
  const { title, input, needle = "", wrap = true, className, parseStrings = true, resetKey } = props;
  const coerced = useMemo(() => coerceJsonInput(input, parseStrings), [input, parseStrings]);
  const signature = resetKey ?? coerced.pretty;
  const [view, setView] = useState<ViewMode>(readViewMode);
  const [collapsed, setCollapsed] = useState(() => initialCollapsedIds(input));
  const [expandedValues, setExpandedValues] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<readonly JsonPathSegment[]>([]);
  useLayoutEffect(() => {
    setCollapsed(initialCollapsedIds(input));
    setExpandedValues(new Set());
    setSelected([]);
  }, [signature]);
  const rows = useMemo(
    () => visibleJsonTree(input, { collapsed, needle }),
    [input, collapsed, needle],
  );
  const selectedId = JSON.stringify(selected);
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
          expandedValues={expandedValues}
          wrap={wrap}
          onSelect={setSelected}
          onToggle={(id) => setCollapsed((current) => toggleId(current, id))}
          onToggleValue={(id) => setExpandedValues((current) => toggleId(current, id))}
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
      <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-[11px] text-primary/90" title={path}>{path}</span>
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
  expandedValues: ReadonlySet<string>;
  wrap: boolean;
  onSelect: (path: readonly JsonPathSegment[]) => void;
  onToggle: (id: string) => void;
  onToggleValue: (id: string) => void;
  onSetCollapsed: (id: string, nextCollapsed: boolean) => void;
}) {
  const { rows, selectedId, collapsed, expandedValues, wrap, onSelect, onToggle, onToggleValue, onSetCollapsed } = props;
  const treeId = useId();
  const activeId = rows.some((row) => row.id === selectedId) ? treeItemDomId(treeId, selectedId) : undefined;
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) return;
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
    } else if (event.key === "Enter" && current && (current.expandable || hasHiddenValue(current))) {
      event.preventDefault();
      if (current.expandable) onToggle(current.id);
      else onToggleValue(current.id);
    }
    if (event.defaultPrevented) event.stopPropagation();
  };
  return (
    <div
      role="tree"
      tabIndex={0}
      aria-activedescendant={activeId}
      onKeyDown={onKey}
      className="json-tree min-w-0 max-h-[min(40rem,70vh)] overflow-auto rounded-md bg-muted/40 px-1.5 py-1.5 font-mono text-[12px] leading-6 outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {rows.map((row) => (
        <TreeRow
          key={row.id}
          row={row}
          domId={treeItemDomId(treeId, row.id)}
          selected={row.id === selectedId}
          collapsed={collapsed.has(row.id)}
          valueExpanded={expandedValues.has(row.id)}
          wrap={wrap}
          onSelect={() => onSelect(row.path)}
          onToggle={() => onToggle(row.id)}
          onToggleValue={() => onToggleValue(row.id)}
        />
      ))}
    </div>
  );
}

function TreeRow(props: {
  row: JsonTreeNode;
  domId: string;
  selected: boolean;
  collapsed: boolean;
  valueExpanded: boolean;
  wrap: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onToggleValue: () => void;
}) {
  const { row, domId, selected, collapsed, valueExpanded, wrap, onSelect, onToggle, onToggleValue } = props;
  const canExpandValue = hasHiddenValue(row);
  const valueId = `${domId}-value`;
  return (
    <div
      id={domId}
      role="treeitem"
      aria-expanded={row.expandable ? !collapsed : undefined}
      aria-selected={selected}
      style={{ paddingLeft: `${row.depth * 1.1}rem` }}
      className={cn(
        "flex min-w-0 cursor-pointer items-start gap-1 rounded-sm px-1",
        selected ? "bg-primary/12" : "hover:bg-accent/50",
        row.matched ? "json-row-match" : "",
      )}
      onClick={() => {
        onSelect();
        if (row.expandable) {
          onToggle();
        } else if (canExpandValue && !valueExpanded) {
          onToggleValue();
        }
      }}
    >
      {row.expandable ? (
        <button
          type="button"
          tabIndex={-1}
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
            onToggle();
          }}
          aria-label={collapsed ? "Expand node" : "Collapse node"}
        >
          {collapsed ? <CaretRightIcon className="size-3" /> : <CaretDownIcon className="size-3" />}
        </button>
      ) : (
        <span className="mt-0.5 inline-block size-4 shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <div className={canExpandValue ? "flex flex-wrap items-baseline justify-between gap-x-2" : "contents"}>
          {row.depth === 0 ? null : <span><span className="json-key">{row.key}</span><span className="json-punct">: </span></span>}
          {canExpandValue ? (
            <Button
              type="button"
              size="xs"
              variant="link"
              className="h-auto px-1 py-0 align-baseline"
              aria-label={`${valueExpanded ? "Collapse" : "Read full"} value at ${row.pathLabel}`}
              aria-expanded={valueExpanded}
              aria-controls={valueId}
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
                onToggleValue();
              }}
            >
              {valueExpanded ? "Show less" : "Show more"}
            </Button>
          ) : null}
        </div>
        {row.expandable ? (
          <span className="text-muted-foreground">{row.type === "array" ? `[${row.childCount}]` : `{${row.childCount}}`}</span>
        ) : (
          <span
            id={valueId}
            className={cn(typeClass(row.type), wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre", canExpandValue && "block")}
          >
            {valueExpanded && typeof row.value === "string" ? row.value : row.preview}
          </span>
        )}
      </div>
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
  const caption = copied ? "Copied" : label || "Copy";
  const button = (
    <Button type="button" size="xs" variant="ghost" className="h-6 gap-1 px-1.5 text-muted-foreground" onClick={copy} disabled={text === ""} aria-label={caption}>
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {label ? <span>{copied ? "Copied" : label}</span> : null}
    </Button>
  );
  if (label) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{caption}</TooltipContent>
    </Tooltip>
  );
}

function treeItemDomId(treeId: string, id: string): string {
  return `json-node-${treeId}-${encodeURIComponent(id)}`;
}

function hasHiddenValue(row: JsonTreeNode): boolean {
  return typeof row.value === "string" && !row.expandable && (row.preview.endsWith("…") || /[\r\n]/.test(row.value));
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
