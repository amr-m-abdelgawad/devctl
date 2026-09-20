import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { downloadLogsExport, fetchLogSessions, fetchPreferences } from "../api.ts";
import { JsonViewer } from "../components/json-viewer.tsx";
import { LogList } from "../components/log-list.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { useLogSession } from "../hooks/use-log-session.ts";
import { ColumnsIcon, DownloadSimpleIcon, MagnifyingGlassIcon, PauseIcon, PlayIcon } from "../icons.ts";
import { cn } from "../lib/utils.ts";
import {
  countNewerThan,
  facetServiceChips,
  filterLogRows,
  lastSeq,
  liveLogsQuery,
  logIdentity,
  logWrapLabel,
  nextLogWrapMode,
  SEARCH_DEBOUNCE_MS,
  type LogWrapMode,
} from "../logs.ts";
import { serviceColor } from "../palette.ts";
import type { LogRow } from "../types.ts";

export function LogsPage(props: { logTotal?: number; serviceNames: string[] }) {
  const { logTotal, serviceNames } = props;
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [regex, setRegex] = useState(false);
  const [errorOnly, setErrorOnly] = useState(false);
  const [showSystem, setShowSystem] = useState(true);
  const [paused, setPaused] = useState(false);
  const [wrapMode, setWrapMode] = useState<LogWrapMode>("clip");
  const [split, setSplit] = useState(false);
  const [splitFocus, setSplitFocus] = useState<0 | 1>(0);
  const [serviceA, setServiceA] = useState("");
  const [serviceB, setServiceB] = useState("");
  const [followA, setFollowA] = useState(true);
  const [followB, setFollowB] = useState(true);
  const [tickA, setTickA] = useState(0);
  const [tickB, setTickB] = useState(0);
  const [selectedA, setSelectedA] = useState("");
  const [selectedB, setSelectedB] = useState("");
  const [pinSeqA, setPinSeqA] = useState<number | undefined>(undefined);
  const [pinSeqB, setPinSeqB] = useState<number | undefined>(undefined);
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<string[]>([]);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [showMeta, setShowMeta] = useState(true);
  const [exportError, setExportError] = useState("");

  const query = useMemo(
    () => liveLogsQuery({
      service: split ? undefined : serviceA,
      errorOnly,
      search,
      regex,
    }),
    [errorOnly, regex, search, serviceA, split],
  );
  const session = useLogSession({ active: true, paused, query, sessionId });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchDraft.trim();
      if (next !== search) {
        setSearch(next);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, searchDraft]);

  useEffect(() => {
    void fetchPreferences().then((prefs) => {
      setShowTimestamps(prefs.values.log_timestamps);
      setShowMeta(prefs.values.log_metadata);
    }).catch(() => {
      setShowTimestamps(true);
      setShowMeta(true);
    });
  }, []);

  useEffect(() => {
    void fetchLogSessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  const filterOpts = useMemo(
    () => ({ errorOnly, search, regex, showSystem, since: session.since }),
    [errorOnly, regex, search, session.since, showSystem],
  );
  const rowsA = useMemo(
    () => filterLogRows(session.events, { ...filterOpts, service: serviceA }),
    [filterOpts, serviceA, session.events],
  );
  const rowsB = useMemo(
    () => filterLogRows(session.events, { ...filterOpts, service: serviceB }),
    [filterOpts, serviceB, session.events],
  );
  const chips = facetServiceChips(session.facets, serviceNames, session.events);
  const newerA = followA ? 0 : countNewerThan(rowsA, pinSeqA);
  const newerB = followB ? 0 : countNewerThan(rowsB, pinSeqB);
  const activeRows = split && splitFocus === 1 ? rowsB : rowsA;
  const selectedId = split && splitFocus === 1 ? selectedB : selectedA;
  const selectedEvent = findById(session.events, selectedId) ?? findById(activeRows, selectedId);
  const loaded = session.events.length;
  const total = session.facets?.total ?? logTotal ?? loaded;

  const pinA = useCallback(() => {
    setFollowA(false);
    setPinSeqA(lastSeq(rowsA));
  }, [rowsA]);
  const pinB = useCallback(() => {
    setFollowB(false);
    setPinSeqB(lastSeq(rowsB));
  }, [rowsB]);
  const jumpA = useCallback(() => {
    setFollowA(true);
    setPinSeqA(undefined);
    setTickA((tick) => tick + 1);
    const tail = rowsA[rowsA.length - 1];
    if (tail) {
      setSelectedA(logIdentity(tail, rowsA.length - 1));
    }
  }, [rowsA]);
  const jumpB = useCallback(() => {
    setFollowB(true);
    setPinSeqB(undefined);
    setTickB((tick) => tick + 1);
    const tail = rowsB[rowsB.length - 1];
    if (tail) {
      setSelectedB(logIdentity(tail, rowsB.length - 1));
    }
  }, [rowsB]);
  const jumpActive = useCallback(() => {
    if (split && splitFocus === 1) {
      jumpB();
      return;
    }
    jumpA();
  }, [jumpA, jumpB, split, splitFocus]);

  const toggleSplit = useCallback(() => {
    if (split) {
      setSplitFocus(0);
      setSplit(false);
      return;
    }
    if (serviceB === "") {
      const other = serviceNames.find((name) => name !== serviceA);
      if (other) {
        setServiceB(other);
      }
    }
    setSplit(true);
  }, [serviceA, serviceB, serviceNames, split]);

  const keysRef = useRef({
    jumpActive,
    toggleSplit,
    activeRows,
    selectedId,
    split,
    splitFocus,
  });
  useEffect(() => {
    keysRef.current = { jumpActive, toggleSplit, activeRows, selectedId, split, splitFocus };
  }, [activeRows, jumpActive, selectedId, split, splitFocus, toggleSplit]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) {
        if (event.key === "Escape") {
          event.target.blur();
        }
        return;
      }
      const latest = keysRef.current;
      if (event.key === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "p") {
        event.preventDefault();
        setPaused((value) => !value);
        return;
      }
      if (event.key === "g") {
        event.preventDefault();
        latest.jumpActive();
        return;
      }
      if (event.key === "e") {
        event.preventDefault();
        setErrorOnly((value) => !value);
        return;
      }
      if (event.key === "\\") {
        event.preventDefault();
        latest.toggleSplit();
        return;
      }
      if (event.key === "w") {
        event.preventDefault();
        setWrapMode((mode) => nextLogWrapMode(mode));
        return;
      }
      const delta = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      moveSelection(
        latest.activeRows,
        latest.selectedId,
        delta,
        latest.split && latest.splitFocus === 1 ? setSelectedB : setSelectedA,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onExport = (): void => {
    setExportError("");
    void downloadLogsExport({ ...query, since: session.since }).catch((err: unknown) => {
      setExportError(err instanceof Error ? err.message : "export failed");
    });
  };

  const inspector = (
    <LogInspector event={selectedEvent} />
  );

  return (
    <Card className="flex min-h-[36rem] flex-col lg:h-[calc(100dvh-7.5rem)] lg:min-h-0">
      <CardHeader className="flex-wrap items-start gap-2">
        <div className="flex w-full flex-wrap items-center gap-2">
          <CardTitle>Logs</CardTitle>
          <Badge variant="muted">
            {total > loaded ? `${loaded.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : loaded.toLocaleString("en-US")}
          </Badge>
          {session.truncated ? <Badge variant="outline">older history</Badge> : null}
          <span className="ml-auto text-[11px] text-muted-foreground">
            j/k move · f search · p pause · g latest · e ERROR+ · \ split · w wrap
          </span>
        </div>
        <Toolbar
          searchDraft={searchDraft}
          searchRef={searchRef}
          regex={regex}
          errorOnly={errorOnly}
          showSystem={showSystem}
          paused={paused}
          wrapMode={wrapMode}
          split={split}
          sessionId={sessionId}
          sessions={sessions}
          showTimestamps={showTimestamps}
          showMeta={showMeta}
          liveLabel={paused ? "paused" : followA && (!split || followB) ? "live" : `pinned · +${Math.max(newerA, newerB)} new`}
          onSearchDraft={setSearchDraft}
          onRegex={() => setRegex((value) => !value)}
          onErrorOnly={() => setErrorOnly((value) => !value)}
          onSystem={() => setShowSystem((value) => !value)}
          onPaused={() => setPaused((value) => !value)}
          onWrap={() => setWrapMode((mode) => nextLogWrapMode(mode))}
          onSplit={toggleSplit}
          onJump={jumpActive}
          onClear={() => {
            session.clear();
            setFollowA(true);
            setFollowB(true);
            setPinSeqA(undefined);
            setPinSeqB(undefined);
          }}
          onExport={onExport}
          onSession={setSessionId}
          onTimestamps={() => setShowTimestamps((value) => !value)}
          onMeta={() => setShowMeta((value) => !value)}
        />
        <ServiceChips chips={chips} active={split && splitFocus === 1 ? serviceB : serviceA} onPick={split && splitFocus === 1 ? setServiceB : setServiceA} />
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-0">
        {session.error || exportError ? (
          <p className="text-xs text-destructive">{session.error || exportError}</p>
        ) : null}
        {split ? (
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
            <LogPane
              title="Pane A"
              active={splitFocus === 0}
              events={rowsA}
              selectedId={selectedA}
              follow={followA}
              followTick={tickA}
              newer={newerA}
              wrapMode={wrapMode}
              showTimestamps={showTimestamps}
              showMeta={showMeta}
              loadingOlder={session.loadingOlder}
              onFocus={() => setSplitFocus(0)}
              onSelect={setSelectedA}
              onPin={pinA}
              onJumpLatest={jumpA}
              onReachTop={session.loadOlder}
            />
            <LogPane
              title="Pane B"
              active={splitFocus === 1}
              events={rowsB}
              selectedId={selectedB}
              follow={followB}
              followTick={tickB}
              newer={newerB}
              wrapMode={wrapMode}
              showTimestamps={showTimestamps}
              showMeta={showMeta}
              loadingOlder={session.loadingOlder}
              onFocus={() => setSplitFocus(1)}
              onSelect={setSelectedB}
              onPin={pinB}
              onJumpLatest={jumpB}
              onReachTop={session.loadOlder}
            />
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border/60">
              <LogList
                events={rowsA}
                selectedId={selectedA}
                onSelect={setSelectedA}
                wrapMode={wrapMode}
                showTimestamps={showTimestamps}
                showMeta={showMeta}
                follow={followA}
                followTick={tickA}
                onPin={pinA}
                onJumpLatest={jumpA}
                newer={newerA}
                onReachTop={session.loadOlder}
                loadingOlder={session.loadingOlder}
                empty={session.loading ? "Loading logs…" : "No log records."}
              />
            </div>
            {inspector}
          </div>
        )}
        {split ? inspector : null}
      </CardContent>
    </Card>
  );
}

function LogInspector(props: { event: LogRow | undefined }) {
  const { event } = props;
  if (!event) {
    return <p className="px-2 py-6 text-center text-xs text-muted-foreground">Select a log row to inspect its JSON.</p>;
  }
  const resetKey = typeof event.seq === "number" ? `seq:${event.seq}` : event.timestamp;
  return <JsonViewer title="Log record" input={event} resetKey={resetKey} />;
}

function LogPane(props: {
  title: string;
  active: boolean;
  events: LogRow[];
  selectedId: string;
  follow: boolean;
  followTick: number;
  newer: number;
  wrapMode: LogWrapMode;
  showTimestamps: boolean;
  showMeta: boolean;
  loadingOlder: boolean;
  onFocus: () => void;
  onSelect: (id: string) => void;
  onPin: () => void;
  onJumpLatest: () => void;
  onReachTop: () => void;
}) {
  const { title, active, onFocus, ...list } = props;
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border",
        active ? "border-primary/50" : "border-border/60",
      )}
    >
      <button
        type="button"
        className="flex items-center justify-between px-2 py-1 text-left text-[10px] uppercase tracking-wide text-muted-foreground"
        onClick={onFocus}
      >
        <span>{title}</span>
        <span>{list.follow ? "live" : "pinned"}</span>
      </button>
      <LogList {...list} empty="No log records." onActivate={onFocus} />
    </div>
  );
}

function Toolbar(props: {
  searchDraft: string;
  searchRef: RefObject<HTMLInputElement | null>;
  regex: boolean;
  errorOnly: boolean;
  showSystem: boolean;
  paused: boolean;
  wrapMode: LogWrapMode;
  split: boolean;
  sessionId: string;
  sessions: string[];
  showTimestamps: boolean;
  showMeta: boolean;
  liveLabel: string;
  onSearchDraft: (value: string) => void;
  onRegex: () => void;
  onErrorOnly: () => void;
  onSystem: () => void;
  onPaused: () => void;
  onWrap: () => void;
  onSplit: () => void;
  onJump: () => void;
  onClear: () => void;
  onExport: () => void;
  onSession: (id: string) => void;
  onTimestamps: () => void;
  onMeta: () => void;
}) {
  const p = props;
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1.5 size-3.5 text-muted-foreground" />
          <input
            ref={p.searchRef}
            type="search"
            value={p.searchDraft}
            onChange={(event) => p.onSearchDraft(event.currentTarget.value)}
            placeholder="Search logs"
            className="h-7 w-full rounded-md border border-border bg-background py-1 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <Toggle active={p.regex} onClick={p.onRegex}>regex</Toggle>
        <Toggle active={p.errorOnly} onClick={p.onErrorOnly} tone="destructive">ERROR+</Toggle>
        <Toggle active={!p.showSystem} onClick={p.onSystem} title="Hide auth, mcp, devctl, and proxy">hide system</Toggle>
        <Button type="button" size="xs" variant={p.paused ? "secondary" : "outline"} onClick={p.onPaused}>
          {p.paused ? <PauseIcon /> : <PlayIcon />}
          {p.paused ? "paused" : "live"}
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={p.onJump}>{p.liveLabel}</Button>
        <Button type="button" size="xs" variant="ghost" onClick={p.onWrap}>{logWrapLabel(p.wrapMode)}</Button>
        <Button type="button" size="xs" variant={p.split ? "secondary" : "ghost"} onClick={p.onSplit}>
          <ColumnsIcon />
          split
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Toggle active={p.showTimestamps} onClick={p.onTimestamps}>timestamps</Toggle>
        <Toggle active={p.showMeta} onClick={p.onMeta}>metadata</Toggle>
        <Button type="button" size="xs" variant="ghost" onClick={p.onClear}>clear</Button>
        <Button type="button" size="xs" variant="ghost" onClick={p.onExport}>
          <DownloadSimpleIcon />
          export
        </Button>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          history
          <select
            value={p.sessionId}
            onChange={(event) => p.onSession(event.currentTarget.value)}
            className="h-7 max-w-[16rem] rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
          >
            <option value="">Live session</option>
            {p.sessions.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function ServiceChips(props: {
  chips: Array<{ name: string; count: number }>;
  active: string;
  onPick: (name: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 w-12 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">service</span>
      {props.chips.map((chip) => (
        <Chip key={chip.name || "all"} active={props.active === chip.name} onClick={() => props.onPick(chip.name)}>
          {chip.name ? <span className="size-1.5 rounded-full" style={{ backgroundColor: serviceColor(chip.name) }} /> : null}
          {chip.name || "all"}
          <span className="text-[10px] text-muted-foreground">{chip.count}</span>
        </Chip>
      ))}
    </div>
  );
}

function Chip(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        props.active
          ? "border-border bg-secondary text-secondary-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function Toggle(props: { active: boolean; onClick: () => void; children: ReactNode; tone?: "destructive"; title?: string }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      className={cn(
        "inline-flex h-7 items-center rounded-md border px-2 text-xs",
        props.active
          ? props.tone === "destructive"
            ? "border-destructive/40 bg-destructive/15 text-destructive"
            : "border-border bg-secondary text-secondary-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/50",
      )}
    >
      {props.children}
    </button>
  );
}

function findById(events: LogRow[], id: string): LogRow | undefined {
  if (id === "") {
    return undefined;
  }
  return events.find((row, index) => logIdentity(row, index) === id);
}

function moveSelection(
  rows: LogRow[],
  selectedId: string,
  delta: number,
  onSelect: (id: string) => void,
): void {
  if (rows.length === 0) {
    return;
  }
  const current = Math.max(0, rows.findIndex((row, index) => logIdentity(row, index) === selectedId));
  const nextIndex = Math.min(rows.length - 1, Math.max(0, current + delta));
  const next = rows[nextIndex];
  if (next) {
    onSelect(logIdentity(next, nextIndex));
  }
}
