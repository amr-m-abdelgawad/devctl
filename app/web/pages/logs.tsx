import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { downloadLogsExport, fetchLogSessions, fetchPreferences } from "../api.ts";
import { JsonViewer } from "../components/json-viewer.tsx";
import { LogList } from "../components/log-list.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { useLogSession } from "../hooks/use-log-session.ts";
import { ColumnsIcon, DownloadSimpleIcon, PauseIcon, PlayIcon } from "../icons.ts";
import { cn } from "../lib/utils.ts";
import {
  countNewerThan,
  facetLevelCount,
  facetServiceChips,
  filterLogRows,
  isErrorLevelPreset,
  lastSeq,
  laterLogSince,
  liveLogsQuery,
  logIdentity,
  logWrapLabel,
  nextLogWrapMode,
  SEARCH_DEBOUNCE_MS,
  SELECTABLE_LOG_LEVELS,
  type LogWrapMode,
} from "../logs.ts";
import { SearchInput, SearchableFilter } from "../components/filters.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { Input } from "../components/ui/input.tsx";
import type { LogRow } from "../types.ts";

export function LogsPage(props: { logTotal?: number; serviceNames: string[]; initialService?: string }) {
  const { logTotal, serviceNames } = props;
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [regex, setRegex] = useState(false);
  const [advanced, setAdvanced] = useState<Record<string, string>>({});
  const [advancedDraft, setAdvancedDraft] = useState<Record<string, string>>({});
  const [dedupe, setDedupe] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [levels, setLevels] = useState<string[]>([]);
  const [hideHealth, setHideHealth] = useState(false);
  const [showSystem, setShowSystem] = useState(true);
  const errorOnly = isErrorLevelPreset(levels);
  const [showGrpc, setShowGrpc] = useState(true);
  const [paused, setPaused] = useState(false);
  const [wrapMode, setWrapMode] = useState<LogWrapMode>("clip");
  const [split, setSplit] = useState(false);
  const [splitFocus, setSplitFocus] = useState<0 | 1>(0);
  const [serviceA, setServiceA] = useState(props.initialService || "");
  useEffect(() => {
    setServiceA(props.initialService || "");
  }, [props.initialService]);
  const [sinceTime, setSinceTime] = useState("");
  const [untilTime, setUntilTime] = useState("");
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
    () => ({
      ...liveLogsQuery({
        service: split ? undefined : serviceA,
        levels,
        hideHealth,
        search,
        regex,
        showGrpc,
        showSystem,
      }),
      ...advanced,
      dedupeRequestId: dedupe,
      since: dateInputIso(sinceTime),
      until: dateInputIso(untilTime),
    }),
    [hideHealth, levels, regex, search, serviceA, showGrpc, showSystem, split, sinceTime, untilTime, advanced, dedupe],
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
    void fetchPreferences()
      .then((prefs) => {
        setShowTimestamps(prefs.values.log_timestamps);
        setShowMeta(prefs.values.log_metadata);
      })
      .catch(() => {
        setShowTimestamps(true);
        setShowMeta(true);
      });
  }, []);

  useEffect(() => {
    void fetchLogSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  const filterOpts = useMemo(
    () => ({ errorOnly, levels, hideHealth, search, regex, showSystem, showGrpc, since: session.since }),
    [errorOnly, hideHealth, levels, regex, search, session.since, showGrpc, showSystem],
  );
  const rowsA = useMemo(() => filterLogRows(session.events, { ...filterOpts, service: serviceA }), [filterOpts, serviceA, session.events]);
  const rowsB = useMemo(() => filterLogRows(session.events, { ...filterOpts, service: serviceB }), [filterOpts, serviceB, session.events]);
  const chips = facetServiceChips(sessionId ? undefined : session.facets, serviceNames, session.events);
  const newerA = followA ? 0 : countNewerThan(rowsA, pinSeqA);
  const newerB = followB ? 0 : countNewerThan(rowsB, pinSeqB);
  const activeRows = split && splitFocus === 1 ? rowsB : rowsA;
  const selectedId = split && splitFocus === 1 ? selectedB : selectedA;
  const selectedEvent = findById(session.events, selectedId) ?? findById(activeRows, selectedId);
  const loaded = session.events.length;
  const total = sessionId ? loaded : (session.facets?.total ?? logTotal ?? loaded);

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
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) {
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
      if (event.key === "z" || event.key === "Escape") {
        event.preventDefault();
        setFullscreen((value) => (event.key === "Escape" ? false : !value));
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
        setLevels((current) => (isErrorLevelPreset(current) ? [] : ["ERROR", "FATAL"]));
        return;
      }
      if (event.key === "b") {
        event.preventDefault();
        setShowGrpc((value) => !value);
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
      moveSelection(latest.activeRows, latest.selectedId, delta, latest.split && latest.splitFocus === 1 ? setSelectedB : setSelectedA);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onExport = (): void => {
    setExportError("");
    void downloadLogsExport({ ...query, since: laterLogSince(query.since, session.since), sessionId: sessionId || undefined }).catch(
      (err: unknown) => {
        setExportError(err instanceof Error ? err.message : "export failed");
      },
    );
  };

  const inspector = <LogInspector event={selectedEvent} />;

  return (
    <Card className={cn("log-workspace", fullscreen && "log-zen")}>
      <CardHeader className="flex-wrap items-start gap-2">
        <div className="flex w-full flex-wrap items-center gap-2">
          <CardTitle>Logs</CardTitle>
          <Badge variant="muted">
            {total > loaded ? `${loaded.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : loaded.toLocaleString("en-US")}
          </Badge>
          {session.truncated ? <Badge variant="outline">older history</Badge> : null}
          <span className="ml-auto hidden text-[11px] text-muted-foreground xl:inline">
            j/k move · f search · p pause · g latest · e ERROR+ · b grpc · levels below · \ split · w wrap
          </span>
        </div>
        <Toolbar
          fullscreen={fullscreen}
          onFullscreen={() => setFullscreen((value) => !value)}
          advanced={advancedDraft}
          advancedActive={Object.values(advanced).some(Boolean) || dedupe}
          onAdvanced={setAdvancedDraft}
          dedupe={dedupe}
          onDedupe={() => setDedupe((value) => !value)}
          onApplyAdvanced={() => setAdvanced(advancedDraft)}
          sinceTime={sinceTime}
          untilTime={untilTime}
          onSince={setSinceTime}
          onUntil={setUntilTime}
          onReset={() => {
            setAdvanced({});
            setAdvancedDraft({});
            setDedupe(false);
            setSearchDraft("");
            setSearch("");
            setRegex(false);
            setLevels([]);
            setHideHealth(false);
            setShowSystem(true);
            setShowGrpc(true);
            setServiceA("");
            setServiceB("");
            setSinceTime("");
            setUntilTime("");
          }}
          searchDraft={searchDraft}
          searchRef={searchRef}
          regex={regex}
          errorOnly={errorOnly}
          hideHealth={hideHealth}
          showSystem={showSystem}
          showGrpc={showGrpc}
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
          onErrorOnly={() => setLevels((current) => (isErrorLevelPreset(current) ? [] : ["ERROR", "FATAL"]))}
          onHideHealth={() => setHideHealth((value) => !value)}
          onSystem={() => setShowSystem((value) => !value)}
          onGrpc={() => setShowGrpc((value) => !value)}
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
        <div className="flex w-full flex-wrap items-center gap-3">
          <SearchableFilter
            label={split ? `Service in pane ${splitFocus === 1 ? "B" : "A"}` : "Service"}
            value={split && splitFocus === 1 ? serviceB : serviceA}
            options={chips.map((chip) => ({ value: chip.name, label: chip.name || "All services", count: chip.count }))}
            onChange={split && splitFocus === 1 ? setServiceB : setServiceA}
          />
          <LevelChips
            levels={levels}
            byLevel={sessionId ? undefined : session.facets?.byLevel}
            onChange={setLevels}
            onClear={() => setLevels([])}
          />
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-0">
        {session.error || exportError ? <p className="text-xs text-destructive">{session.error || exportError}</p> : null}
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
      className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border", active ? "border-primary/50" : "border-border/60")}
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
  fullscreen: boolean;
  onFullscreen: () => void;
  advanced: Record<string, string>;
  advancedActive: boolean;
  onAdvanced: (value: Record<string, string>) => void;
  dedupe: boolean;
  onDedupe: () => void;
  onApplyAdvanced: () => void;
  sinceTime: string;
  untilTime: string;
  onSince: (value: string) => void;
  onUntil: (value: string) => void;
  onReset: () => void;
  searchDraft: string;
  searchRef: RefObject<HTMLInputElement | null>;
  regex: boolean;
  errorOnly: boolean;
  hideHealth: boolean;
  showSystem: boolean;
  showGrpc: boolean;
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
  onHideHealth: () => void;
  onSystem: () => void;
  onGrpc: () => void;
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
    <div className="log-toolbar">
      <div className="log-toolbar-primary">
        <SearchInput
          label="Search logs"
          ref={p.searchRef}
          value={p.searchDraft}
          onChange={(event) => p.onSearchDraft(event.currentTarget.value)}
        />
        <Toggle active={p.regex} onClick={p.onRegex}>
          Regex
        </Toggle>
        <Toggle active={p.errorOnly} onClick={p.onErrorOnly} tone="destructive">
          ERROR+
        </Toggle>
        <Button
          size="sm"
          variant={p.paused ? "secondary" : "outline"}
          onClick={p.onPaused}
          aria-label={p.paused ? "Resume live logs" : "Pause live logs"}
        >
          {p.paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
          {p.paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="outline" onClick={p.onJump}>
          {p.liveLabel === "live" ? "Latest" : p.liveLabel}
        </Button>
        <Button size="sm" variant="outline" onClick={p.onFullscreen} aria-pressed={p.fullscreen}>
          {p.fullscreen ? "Exit full screen" : "Full screen"}
        </Button>
        <Button size="sm" variant="ghost" onClick={p.onExport}>
          <DownloadSimpleIcon data-icon="inline-start" />
          Export
        </Button>
      </div>
      <details className="log-option-panel">
        <summary>
          Filters & view options
          {p.hideHealth || !p.showSystem || !p.showGrpc || p.sinceTime || p.untilTime || p.advancedActive ? (
            <Badge variant="info">Active</Badge>
          ) : null}
        </summary>
        <div className="log-options">
          <span className="log-option-label">Noise filters</span>
          <Toggle active={p.hideHealth} onClick={p.onHideHealth}>
            Hide health checks
          </Toggle>
          <Toggle active={!p.showSystem} onClick={p.onSystem}>
            Hide system
          </Toggle>
          <Toggle active={!p.showGrpc} onClick={p.onGrpc}>
            Hide gRPC
          </Toggle>
          <span className="log-option-label">Time range</span>
          <label className="log-date">
            Since
            <Input
              type="datetime-local"
              value={p.sinceTime}
              max={p.untilTime || undefined}
              onChange={(event) => p.onSince(event.currentTarget.value)}
            />
          </label>
          <label className="log-date">
            Until
            <Input
              type="datetime-local"
              value={p.untilTime}
              min={p.sinceTime || undefined}
              onChange={(event) => p.onUntil(event.currentTarget.value)}
            />
          </label>
          <span className="log-option-label">Source & correlation</span>
          <div className="log-advanced">
            {[
              { key: "source", label: "Source", placeholder: "stdout, stderr, auth…" },
              { key: "requestId", label: "Request ID", placeholder: "X-Devctl-Request-ID" },
              { key: "traceId", label: "Trace ID", placeholder: "W3C trace ID" },
              { key: "attributeKey", label: "Attribute key", placeholder: "http.method" },
              { key: "attributeValue", label: "Attribute value", placeholder: "GET" },
            ].map((field) => (
              <label key={field.key} className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
                {field.label}
                <Input
                  value={p.advanced[field.key] || ""}
                  placeholder={field.placeholder}
                  onChange={(event) => p.onAdvanced({ ...p.advanced, [field.key]: event.currentTarget.value })}
                />
              </label>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={p.onApplyAdvanced}>
            Apply correlation filters
          </Button>
          <Toggle active={p.dedupe} onClick={p.onDedupe}>
            Dedupe request IDs
          </Toggle>
          <span className="log-option-label">Display</span>
          <Toggle active={p.showTimestamps} onClick={p.onTimestamps}>
            Timestamps
          </Toggle>
          <Toggle active={p.showMeta} onClick={p.onMeta}>
            Metadata
          </Toggle>
          <Button size="sm" variant="outline" onClick={p.onWrap}>
            {logWrapLabel(p.wrapMode)}
          </Button>
          <Button size="sm" variant={p.split ? "secondary" : "outline"} onClick={p.onSplit} aria-pressed={p.split}>
            <ColumnsIcon data-icon="inline-start" />
            Split panes
          </Button>
          <span className="log-option-label">Session</span>
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
            History
            <select
              value={p.sessionId}
              onChange={(event) => p.onSession(event.currentTarget.value)}
              className="h-9 min-w-0 max-w-full flex-1 rounded-md border bg-background px-2 text-xs"
            >
              <option value="">Live session</option>
              {p.sessions.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="ghost" onClick={p.onClear}>
            Clear view
          </Button>
          <Button size="sm" variant="ghost" onClick={p.onReset}>
            Reset filters
          </Button>
        </div>
      </details>
    </div>
  );
}

function LevelChips(props: {
  levels: string[];
  byLevel: Record<string, number> | undefined;
  onChange: (levels: string[]) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant={props.levels.length === 0 ? "secondary" : "ghost"}
        onClick={props.onClear}
        aria-pressed={props.levels.length === 0}
      >
        All levels
      </Button>
      <ToggleGroup
        type="multiple"
        size="sm"
        spacing={1}
        aria-label="Log levels"
        value={props.levels}
        onValueChange={props.onChange}
        className="flex-wrap"
      >
        {SELECTABLE_LOG_LEVELS.map((level) => (
          <ToggleGroupItem key={level} value={level} aria-label={level}>
            {level.toLowerCase()}
            {props.byLevel ? <span className="ml-1 text-[10px] text-muted-foreground">{facetLevelCount(props.byLevel, level)}</span> : null}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function dateInputIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function Toggle(props: { active: boolean; onClick: () => void; children: ReactNode; tone?: "destructive"; title?: string }) {
  return (
    <Button
      size="sm"
      variant={props.active ? (props.tone === "destructive" ? "destructive" : "secondary") : "ghost"}
      aria-pressed={props.active}
      title={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

function findById(events: LogRow[], id: string): LogRow | undefined {
  if (id === "") {
    return undefined;
  }
  return events.find((row, index) => logIdentity(row, index) === id);
}

function moveSelection(rows: LogRow[], selectedId: string, delta: number, onSelect: (id: string) => void): void {
  if (rows.length === 0) {
    return;
  }
  const current = Math.max(
    0,
    rows.findIndex((row, index) => logIdentity(row, index) === selectedId),
  );
  const nextIndex = Math.min(rows.length - 1, Math.max(0, current + delta));
  const next = rows[nextIndex];
  if (next) {
    onSelect(logIdentity(next, nextIndex));
  }
}
