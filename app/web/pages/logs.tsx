import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { downloadLogsExport, fetchLogSessions, fetchPreferences } from "../api.ts";
import { JsonViewer } from "../components/json-viewer.tsx";
import { LogList, LogSearchText } from "../components/log-list.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { IconButton } from "../components/ui/icon-button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { useLogSession } from "../hooks/use-log-session.ts";
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ColumnsIcon,
  CopyIcon,
  DownloadSimpleIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
} from "../icons.ts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { ChoiceGroup, FilterSelect } from "../components/filters.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "../components/ui/dropdown-menu.tsx";
import { clockMs } from "../format.ts";
import { StatusBadge } from "../components/status.tsx";
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
  logSearchFinder,
  logWrapLabel,
  nextLogWrapMode,
  nextPinSeq,
  nextLogSelectionIndex,
  SEARCH_DEBOUNCE_MS,
  SELECTABLE_LOG_LEVELS,
  toggleListedLevel,
  type LogWrapMode,
} from "../logs.ts";
import { SearchInput, SearchableFilter } from "../components/filters.tsx";
import { Input } from "../components/ui/input.tsx";
import type { LogRow } from "../types.ts";

export function LogsPage(props: { logTotal?: number; serviceNames: string[]; initialService?: string; initialSeq?: number }) {
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
  const [wrapMode, setWrapMode] = useState<LogWrapMode>("focus");
  const [split, setSplit] = useState(false);
  const [splitFocus, setSplitFocus] = useState<0 | 1>(0);
  const [serviceA, setServiceA] = useState(props.initialService || "");
  useEffect(() => {
    setServiceA(props.initialService || "");
  }, [props.initialService]);
  useEffect(() => {
    if (typeof props.initialSeq !== "number") {
      return;
    }
    setSelectedA(`seq:${props.initialSeq}`);
    setFollowA(false);
    setPinSeqA(props.initialSeq);
  }, [props.initialSeq]);
  const pinnedOnArrival = typeof props.initialSeq === "number";
  const [sinceTime, setSinceTime] = useState("");
  const [untilTime, setUntilTime] = useState("");
  const [serviceB, setServiceB] = useState("");
  const [followA, setFollowA] = useState(!pinnedOnArrival);
  const [followB, setFollowB] = useState(true);
  const [tickA, setTickA] = useState(0);
  const [tickB, setTickB] = useState(0);
  const [selectedA, setSelectedA] = useState(pinnedOnArrival ? `seq:${props.initialSeq}` : "");
  const [selectedB, setSelectedB] = useState("");
  const [pinSeqA, setPinSeqA] = useState<number | undefined>(pinnedOnArrival ? props.initialSeq : undefined);
  const [pinSeqB, setPinSeqB] = useState<number | undefined>(undefined);
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<string[]>([]);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [showMeta, setShowMeta] = useState(true);
  const [exportError, setExportError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const changed = (): void => {
      setWide(media.matches);
      if (!media.matches) setInspectorOpen(false);
    };
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

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
    setPinSeqA((current) => nextPinSeq(followA, current, lastSeq(rowsA)));
  }, [followA, rowsA]);
  const pinB = useCallback(() => {
    setFollowB(false);
    setPinSeqB((current) => nextPinSeq(followB, current, lastSeq(rowsB)));
  }, [followB, rowsB]);
  const selectRow = useCallback(
    (id: string, pane: 0 | 1) => {
      if (pane === 1) {
        setSelectedB(id);
        pinB();
      } else {
        setSelectedA(id);
        pinA();
      }
      setSplitFocus(pane);
      if (wide) setInspectorOpen(true);
    },
    [pinA, pinB, wide],
  );
  const inspectRow = useCallback(
    (id: string, pane: 0 | 1) => {
      selectRow(id, pane);
      setInspectorOpen(true);
    },
    [selectRow],
  );
  const selectA = useCallback((id: string) => selectRow(id, 0), [selectRow]);
  const selectB = useCallback((id: string) => selectRow(id, 1), [selectRow]);
  const inspectA = useCallback((id: string) => inspectRow(id, 0), [inspectRow]);
  const inspectB = useCallback((id: string) => inspectRow(id, 1), [inspectRow]);
  const selectActive = split && splitFocus === 1 ? selectB : selectA;
  const jumpA = useCallback(() => {
    setFollowA(true);
    setPinSeqA(undefined);
    setTickA((tick) => tick + 1);
    setSelectedA("");
    setInspectorOpen(false);
  }, []);
  const jumpB = useCallback(() => {
    setFollowB(true);
    setPinSeqB(undefined);
    setTickB((tick) => tick + 1);
    setSelectedB("");
    setInspectorOpen(false);
  }, []);
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
    selectActive,
  });
  useEffect(() => {
    keysRef.current = { jumpActive, toggleSplit, activeRows, selectedId, split, splitFocus, selectActive };
  }, [activeRows, jumpActive, selectedId, split, splitFocus, toggleSplit, selectActive]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], button, a")
      ) {
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
        if (event.key === "Escape") setInspectorOpen(false);
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
      moveSelection(latest.activeRows, latest.selectedId, delta, latest.selectActive);
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

  const selectedIndex = activeRows.findIndex((row, index) => logIdentity(row, index) === selectedId);
  const navigateSelection = (delta: number): void => moveSelection(activeRows, selectedId, delta, selectActive);
  const closeSelection = (): void => {
    setSelectedA("");
    setSelectedB("");
    setInspectorOpen(false);
  };
  const copyMessage = (): void => {
    if (selectedEvent)
      void navigator.clipboard
        .writeText(selectedEvent.message)
        .then(() => setCopied(selectedId))
        .catch(() => setCopied("failed"));
  };

  const levelControls = (
    <LevelFilter
      levels={levels}
      byLevel={sessionId ? undefined : session.facets?.byLevel}
      onChange={setLevels}
      onClear={() => setLevels([])}
    />
  );
  return (
    <Card className={cn("log-workspace", fullscreen && "log-zen")}>
      <CardHeader className="flex-wrap items-start gap-2">
        <div className="flex w-full flex-wrap items-center gap-2">
          <CardTitle>Logs</CardTitle>
          <Badge variant="muted">
            {total > loaded ? `${loaded.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : loaded.toLocaleString("en-US")}
          </Badge>
          {session.truncated ? <Badge variant="outline">older history</Badge> : null}
          <span className="ml-auto hidden text-[12px] text-muted-foreground xl:inline">
            Click to select · ↑/↓ move · Enter inspect · f search · p pause · g latest
          </span>
        </div>
        <Toolbar
          fullscreen={fullscreen}
          onFullscreen={() => setFullscreen((value) => !value)}
          advanced={advancedDraft}
          advancedActive={Object.values(advanced).some(Boolean) || dedupe}
          filtersActive={
            hideHealth ||
            !showSystem ||
            !showGrpc ||
            sinceTime !== "" ||
            untilTime !== "" ||
            Object.values(advanced).some(Boolean) ||
            dedupe ||
            levels.length > 0 ||
            serviceA !== "" ||
            serviceB !== "" ||
            regex ||
            search !== ""
          }
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
          onWrapMode={setWrapMode}
          onSplit={toggleSplit}
          onJump={jumpActive}
          onClear={() => {
            session.clear();
            closeSelection();
            setFollowA(true);
            setFollowB(true);
            setPinSeqA(undefined);
            setPinSeqB(undefined);
          }}
          onExport={onExport}
          onSession={setSessionId}
          onTimestamps={() => setShowTimestamps((value) => !value)}
          onMeta={() => setShowMeta((value) => !value)}
          scopeFilters={
            <>
              <SearchableFilter
                label={split ? `Service in pane ${splitFocus === 1 ? "B" : "A"}` : "Service"}
                value={split && splitFocus === 1 ? serviceB : serviceA}
                options={chips.map((chip) => ({ value: chip.name, label: chip.name || "All services", count: chip.count }))}
                onChange={split && splitFocus === 1 ? setServiceB : setServiceA}
              />
              {levelControls}
            </>
          }
        />
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-0">
        {session.error || exportError ? <p className="text-xs text-destructive">{session.error || exportError}</p> : null}
        {selectedEvent ? (
          <div className="log-selection-bar" role="region" aria-label="Selected log">
            <div className="log-selection-summary">
              <StatusBadge value={selectedEvent.level || selectedEvent.severityText || "info"} />
              <span className="truncate font-medium">{selectedEvent.service}</span>
              <time className="font-mono text-[12px] text-muted-foreground">{clockMs(selectedEvent.timestamp)}</time>
              <span className="text-[12px] text-muted-foreground">Selected · view pinned</span>
            </div>
            <div className="log-selection-actions">
              <IconButton size="xs" variant="ghost" label="Previous log" disabled={selectedIndex <= 0} onClick={() => navigateSelection(-1)}>
                <CaretLeftIcon />
              </IconButton>
              <IconButton
                size="xs"
                variant="ghost"
                label="Next log"
                disabled={selectedIndex < 0 || selectedIndex >= activeRows.length - 1}
                onClick={() => navigateSelection(1)}
              >
                <CaretRightIcon />
              </IconButton>
              <Button
                size="xs"
                variant="ghost"
                onClick={copyMessage}
                aria-label={copied === selectedId ? "Copied message" : "Copy message"}
                title={copied === selectedId ? "Copied" : "Copy message"}
              >
                <CopyIcon data-icon="inline-start" />
                <span className="hidden sm:inline">{copied === selectedId ? "Copied" : "Copy message"}</span>
              </Button>
              <Button size="xs" variant="outline" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen((value) => !value)}>
                {wide && inspectorOpen ? "Hide details" : "Inspect record"}
              </Button>
              <IconButton size="xs" variant="ghost" label="Clear log selection" onClick={closeSelection}>
                <XIcon />
              </IconButton>
            </div>
            {copied === "failed" ? (
              <span role="status" className="text-xs text-warning">
                Clipboard unavailable. Select the message in details to copy it.
              </span>
            ) : null}
          </div>
        ) : (
          <p className="log-selection-hint">Select a row to read its message. Open details with the arrow or Enter.</p>
        )}
        <div className={cn("log-body", wide && inspectorOpen && selectedEvent && "log-body-inspecting")}>
          {split ? (
            <div className="log-streams log-streams-split">
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
                search={search}
                regex={regex}
                loadingOlder={session.loadingOlder}
                onFocus={() => setSplitFocus(0)}
                onSelect={selectA}
                onInspect={inspectA}
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
                search={search}
                regex={regex}
                loadingOlder={session.loadingOlder}
                onFocus={() => setSplitFocus(1)}
                onSelect={selectB}
                onInspect={inspectB}
                onPin={pinB}
                onJumpLatest={jumpB}
                onReachTop={session.loadOlder}
              />
            </div>
          ) : (
            <div className="log-streams">
              <div className="log-stream">
                <LogList
                  events={rowsA}
                  selectedId={selectedA}
                  onSelect={selectA}
                  onInspect={inspectA}
                  wrapMode={wrapMode}
                  showTimestamps={showTimestamps}
                  showMeta={showMeta}
                  search={search}
                  regex={regex}
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
            </div>
          )}
          {wide && inspectorOpen && selectedEvent ? (
            <aside className="log-details" aria-label="Log details">
              <div className="log-details-heading">
                <h3>Log details</h3>
                <IconButton size="xs" variant="ghost" label="Close log details" onClick={() => setInspectorOpen(false)}>
                  <XIcon />
                </IconButton>
              </div>
              <LogInspector event={selectedEvent} search={search} regex={regex} />
            </aside>
          ) : null}
        </div>
        <Dialog open={!wide && inspectorOpen && Boolean(selectedEvent)} onOpenChange={setInspectorOpen}>
          <DialogContent className="log-details-dialog">
            <DialogHeader>
              <DialogTitle>Log details</DialogTitle>
              <DialogDescription>
                {selectedEvent ? `${selectedEvent.service} · ${clockMs(selectedEvent.timestamp)}` : "Selected log record"}
              </DialogDescription>
            </DialogHeader>
            {selectedEvent ? <LogInspector event={selectedEvent} search={search} regex={regex} /> : null}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function LogInspector(props: { event: LogRow; search: string; regex: boolean }) {
  const { event, search, regex } = props;
  const [view, setView] = useState("message");
  const findSearch = useMemo(() => logSearchFinder(search, regex), [search, regex]);
  const resetKey = typeof event.seq === "number" ? `seq:${event.seq}` : event.timestamp;
  return (
    <div className="log-record-detail">
      <ChoiceGroup
        label="Log detail view"
        value={view}
        onChange={setView}
        options={[
          { value: "message", label: "Message" },
          { value: "json", label: "JSON" },
        ]}
      />
      <div className="log-detail-scroll">
        {view === "json" ? (
          <JsonViewer title="Log record" input={event} resetKey={resetKey} />
        ) : (
          <>
            <dl className="log-record-facts">
              <div>
                <dt>Service</dt>
                <dd>
                  <LogSearchText text={event.service} find={findSearch} />
                </dd>
              </div>
              <div>
                <dt>Level</dt>
                <dd>
                  <StatusBadge value={event.level || event.severityText || "info"} />
                </dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>{event.timestamp}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  <LogSearchText text={event.source} find={findSearch} />
                </dd>
              </div>
              {event.traceId ? (
                <div>
                  <dt>Trace</dt>
                  <dd>{event.traceId}</dd>
                </div>
              ) : null}
            </dl>
            <h4 className="mb-2 mt-5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Message</h4>
            <pre className="log-readable-message">
              <LogSearchText text={event.message} find={findSearch} />
            </pre>
          </>
        )}
      </div>
    </div>
  );
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
  search: string;
  regex: boolean;
  loadingOlder: boolean;
  onFocus: () => void;
  onSelect: (id: string) => void;
  onInspect: (id: string) => void;
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
        className="flex items-center justify-between px-2 py-1 text-left text-[11px] uppercase tracking-wide text-muted-foreground"
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
  filtersActive: boolean;
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
  scopeFilters: ReactNode;
  onSearchDraft: (value: string) => void;
  onRegex: () => void;
  onErrorOnly: () => void;
  onHideHealth: () => void;
  onSystem: () => void;
  onGrpc: () => void;
  onPaused: () => void;
  onWrap: () => void;
  onWrapMode: (mode: LogWrapMode) => void;
  onSplit: () => void;
  onJump: () => void;
  onClear: () => void;
  onExport: () => void;
  onSession: (id: string) => void;
  onTimestamps: () => void;
  onMeta: () => void;
}) {
  const p = props;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const optionsRef = useRef<HTMLButtonElement>(null);
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
        <Button size="sm" variant="outline" onClick={p.onJump} title="Return to live logs and clear selection">
          Latest
        </Button>
        {p.liveLabel !== "live" ? <Badge variant="muted">{p.liveLabel}</Badge> : null}
        <Button size="sm" variant="outline" onClick={p.onFullscreen} aria-pressed={p.fullscreen}>
          {p.fullscreen ? "Exit full screen" : "Full screen"}
        </Button>
        <Button size="sm" variant="ghost" onClick={p.onExport}>
          <DownloadSimpleIcon data-icon="inline-start" />
          Export
        </Button>
      </div>
      <div className="flex w-full flex-wrap items-center gap-2">
        {p.scopeFilters}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={optionsRef} size="sm" variant="outline">
              Filters & view options
              <CaretDownIcon data-icon="inline-end" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-64"
            onCloseAutoFocus={(event) => {
              if (filtersOpen) event.preventDefault();
            }}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Noise filters</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={p.hideHealth}
                onCheckedChange={p.onHideHealth}
                onSelect={(event) => event.preventDefault()}
              >
                Hide health checks
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={!p.showSystem} onCheckedChange={p.onSystem} onSelect={(event) => event.preventDefault()}>
                Hide system logs
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={!p.showGrpc} onCheckedChange={p.onGrpc} onSelect={(event) => event.preventDefault()}>
                Hide gRPC logs
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Display</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={p.showTimestamps}
                onCheckedChange={p.onTimestamps}
                onSelect={(event) => event.preventDefault()}
              >
                Timestamps
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={p.showMeta} onCheckedChange={p.onMeta} onSelect={(event) => event.preventDefault()}>
                Metadata
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={p.split} onCheckedChange={p.onSplit}>
                Split panes
              </DropdownMenuCheckboxItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="hidden sm:flex">
                  Line wrapping
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{logWrapLabel(p.wrapMode)}</span>
                    <DropdownMenuShortcut className="ml-0">w</DropdownMenuShortcut>
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Line wrapping</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={p.wrapMode} onValueChange={(value) => p.onWrapMode(value as LogWrapMode)}>
                        {(["clip", "focus", "all"] as const).map((mode) => (
                          <DropdownMenuRadioItem key={mode} value={mode}>
                            {logWrapLabel(mode)}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={p.onFullscreen}>
                {p.fullscreen ? "Exit full screen" : "Full screen"}
                <DropdownMenuShortcut>z</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuGroup className="sm:hidden">
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Line wrapping</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={p.wrapMode} onValueChange={(value) => p.onWrapMode(value as LogWrapMode)}>
                {(["clip", "focus", "all"] as const).map((mode) => (
                  <DropdownMenuRadioItem key={mode} value={mode}>
                    {logWrapLabel(mode)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="hidden sm:flex">Session history</DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="max-h-80 w-64 max-w-[calc(100vw-1rem)] overflow-y-auto">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Log session</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={p.sessionId} onValueChange={p.onSession}>
                        <DropdownMenuRadioItem value="">Live session</DropdownMenuRadioItem>
                        {p.sessions.map((id) => (
                          <DropdownMenuRadioItem key={id} value={id}>
                            <span className="truncate">{id}</span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuItem className="sm:hidden" onSelect={() => setFiltersOpen(true)}>Session history…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setFiltersOpen(true)}>All filters & session history…</DropdownMenuItem>
              <DropdownMenuItem onSelect={p.onExport}>Export logs</DropdownMenuItem>
              <DropdownMenuItem onSelect={p.onReset}>Reset filters</DropdownMenuItem>
              <DropdownMenuItem onSelect={p.onClear}>Clear view</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {p.filtersActive ? (
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="info">Filters active</Badge>
            <Button size="sm" variant="ghost" onClick={p.onReset}>
              Clear filters
            </Button>
          </div>
        ) : null}
      </div>
      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DialogContent
          className="log-filter-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            optionsRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Log filters and view options</DialogTitle>
            <DialogDescription>Choose sources, correlation fields, time bounds, and a saved session.</DialogDescription>
          </DialogHeader>
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
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                p.onApplyAdvanced();
                setFiltersOpen(false);
              }}
            >
              Apply filters
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
            <FilterSelect
              label="Log history"
              value={p.sessionId}
              onChange={p.onSession}
              options={[{ value: "", label: "Live session" }, ...p.sessions.map((id) => ({ value: id, label: id }))]}
            />
            <Button size="sm" variant="ghost" onClick={p.onClear}>
              Clear view
            </Button>
            <Button size="sm" variant="ghost" onClick={p.onReset}>
              Reset filters
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LevelFilter(props: {
  levels: string[];
  byLevel: Record<string, number> | undefined;
  onChange: (levels: string[]) => void;
  onClear: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" aria-label="Filter log levels">
          {props.levels.length === 0 ? "All levels" : props.levels.length < 3 ? props.levels.join(", ") : props.levels.length + " levels"}
          <CaretDownIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Log levels</DropdownMenuLabel>
          <DropdownMenuItem onSelect={props.onClear}>All levels</DropdownMenuItem>
          <DropdownMenuSeparator />
          {SELECTABLE_LOG_LEVELS.map((level) => (
            <DropdownMenuCheckboxItem
              key={level}
              checked={props.levels.includes(level)}
              onCheckedChange={() => props.onChange(toggleListedLevel(props.levels, level))}
              onSelect={(event) => event.preventDefault()}
            >
              {level.toLowerCase()}
              {props.byLevel ? (
                <span className="ml-auto font-mono text-xs text-muted-foreground">{facetLevelCount(props.byLevel, level)}</span>
              ) : null}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const current = rows.findIndex((row, index) => logIdentity(row, index) === selectedId);
  const nextIndex = nextLogSelectionIndex(rows.length, current, delta);
  const next = rows[nextIndex];
  if (next) {
    onSelect(logIdentity(next, nextIndex));
  }
}
