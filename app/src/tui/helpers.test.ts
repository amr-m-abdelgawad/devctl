import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../config/types.ts";
import { ConfigurationReloadFailed } from "../events.ts";
import { alreadyUpNames, appendVisibleLogs, canStartAll, CHROME_RESERVED, chromeReserved, clipText, commandSelectOptions, compactChrome, COMPACT_CHROME_HEIGHT, confirmCopy, countRunning, cycleLogService, defaultProfileName, envKeyColumnWidth, explicitServices, facetFilterCatalog, facetServiceCounts, factTableColumns, filterLogs, fleetFacts, focusedServices, foldLogLines, formatLoadAvg, formatLogDetails, formatLogLine, formatLogsForClipboard, formatCpuPercent, formatMemoryKB, formatRatioPercent, formatStarted, formatStopped, formatUptime, footerHints, googleProjectDisplay, groupedCommands, HEADER_NARROW_WIDTH, HEADER_STACK_WIDTH, headerStatusChips, INTERNAL_LOG_SERVICES, isActiveRuntime, leftoverCopy, leftoverTone, loadCopy, loadPerCpu, loadTone, logCursorStep, logFilterCatalog, logFilterSources, logMessageSpans, logMessageWidth, LOG_TIME_COL, logPaneInnerWidth, logPinStart, logRowExpanded, logServiceColumnWidth, logServiceCounts, logViewWindow, logWrapLabel, memoryTone, memoryUsedKB, mergeLoadedPage, NAV_ITEMS, navActiveIndex, navItemForDigit, navTabLabel, needsOlderLogPage, nextLogWrapMode, nextScreen, noneStarted, overlayRect, padClip, pendingPlanWaves, pickLogService, planActionCopy, planHeadline, planNextAction, planOverlayHeight, planProgress, planRowNote, planServices, planTitle, platformLabel, prependOlderPage, prettyPrintLogRaw, prevScreen, previousSessionNote, reloadFailureMessage, renderBar, runningLabel, runtimeUptime, screenListCount, selectedSlashCommand, serviceCheckLabel, serviceCommandText, serviceEnvEntries, serviceFleetStats, serviceHealthText, serviceIdentityText, serviceListInnerWidth, serviceListPaneWidth, serviceNameColumnWidth, servicePortsText, serviceRestartText, serviceStatusLabel, slashWindowStart, STATS_FACT_GAP, statsPaneWidth, statsServiceColumns, statusChipTone, statusStripChips, stripAnsi, tabChipWidth, topLogSources, usesTrafficHealth, visibleHints, visibleLogErrorCount, visibleLogs, visibleTabRange, waveCardTitle, waveStatus, wrapLogMessage } from "./helpers.ts";
import { allCommands } from "./commands.ts";
import { defaultCopyKeybind } from "./tui-config.ts";

describe("TUI helpers", () => {
  test("default profile is the first sorted name", () => {
    const cfg = defaultConfig();
    cfg.profiles = { backend: { services: ["api"], environment: {} }, full: { services: ["api"], environment: {} } };
    expect(defaultProfileName(cfg)).toBe("backend");
    cfg.profiles = { full: { services: ["api"], environment: {} }, zebra: { services: ["api"], environment: {} } };
    expect(defaultProfileName(cfg)).toBe("full");
  });

  test("noneStarted treats missing snapshot as empty", () => {
    expect(noneStarted(undefined)).toBe(true);
  });

  test("visibleLogs only scopes by an explicit since boundary, never by service start or stop state", () => {
    const systemEvent = {
      timestamp: "2026-08-30T00:00:00.000Z",
      service: "devctl",
      source: "devctl",
      level: "INFO",
      message: "supervisor started session=abc",
      pid: 0,
      seq: 1,
    };
    const serviceEvent = { ...systemEvent, timestamp: "2026-08-30T00:00:05.000Z", service: "api", source: "api", message: "ready" };
    // Stopping every service must not clear the view — there's no `snap` parameter to react to that.
    expect(visibleLogs([systemEvent, serviceEvent])).toEqual([systemEvent, serviceEvent]);
    const later = { ...serviceEvent, timestamp: "2026-08-30T00:01:00.000Z", message: "ready again" };
    expect(visibleLogs([systemEvent, serviceEvent, later], "2026-08-30T00:00:30.000Z")).toEqual([later]);
  });

  test("appendVisibleLogs keeps regular per-service logs visible after a stop", () => {
    const sys = (ts: string, message: string) => ({ timestamp: ts, service: "devctl", source: "devctl", level: "INFO", message, pid: 0 });
    const svc = (ts: string, message: string) => ({ timestamp: ts, service: "api", source: "api", level: "INFO", message, pid: 0 });
    const current = [sys("2026-08-30T00:00:00.000Z", "old-sys"), svc("2026-08-30T00:00:01.000Z", "old-svc")];
    const next = appendVisibleLogs(
      current as never,
      [svc("2026-08-30T00:00:02.000Z", "new-svc"), sys("2026-08-30T00:00:03.000Z", "new-sys")] as never,
      "",
      50,
    );
    expect(next.map((event) => event.message)).toEqual(["old-sys", "old-svc", "new-svc", "new-sys"]);
  });

  test("visible error count matches rows the dashboard can open", () => {
    expect(visibleLogErrorCount([
      { timestamp: "2026-08-30T00:00:00.000Z", service: "api", level: "INFO", message: "ready" },
      { timestamp: "2026-08-30T00:00:01.000Z", service: "api", level: "ERROR", message: "failed" },
      { timestamp: "2026-08-30T00:00:02.000Z", service: "api", level: "FATAL", message: "stopped" },
    ] as never)).toBe(2);
  });

  test("live log append filters only the incoming batch and keeps the cap", () => {
    const event = (timestamp: string, message: string) => ({ timestamp, service: "api", level: "INFO", message });
    const current = [event("2026-08-30T00:00:01.000Z", "one"), event("2026-08-30T00:00:02.000Z", "two")];
    const next = appendVisibleLogs(
      current as never,
      [event("2026-08-30T00:00:00.000Z", "old"), event("2026-08-30T00:00:03.000Z", "three")] as never,
      "2026-08-30T00:00:01.000Z",
      3,
    );
    expect(next.map((item) => item.message)).toEqual(["one", "two", "three"]);
  });

  test("log filters keep all services until a chip is chosen", () => {
    const events = [
      { timestamp: "t", service: "auth", source: "auth", level: "INFO", message: "up", pid: 1, seq: 1 },
      { timestamp: "t", service: "api", source: "api", level: "ERROR", message: "boom", pid: 2, seq: 2 },
    ];
    expect(filterLogs(events, {}).map((ev) => ev.service)).toEqual(["auth", "api"]);
    expect(filterLogs(events, { service: "api" }).map((ev) => ev.service)).toEqual(["api"]);
    expect(filterLogs(events, { errorOnly: true }).map((ev) => ev.service)).toEqual(["api"]);
    expect(filterLogs(events, { search: "up" }).map((ev) => ev.service)).toEqual(["auth"]);
    expect(filterLogs(events, { services: ["api", "auth"], regex: true, search: "^b" }).map((ev) => ev.service)).toEqual(["api"]);
    expect(filterLogs(events, { source: "auth" }).map((ev) => ev.service)).toEqual(["auth"]);
    expect(filterLogs(events, { until: "2026-01-01T00:00:00.000Z" })).toEqual([]);
    expect(filterLogs(events, { systemLogs: false }).map((ev) => ev.service)).toEqual(["api"]);
    expect(filterLogs(events, { systemLogs: true }).map((ev) => ev.service)).toEqual(["auth", "api"]);
    expect(logServiceCounts(events, ["auth", "api"]).map((row) => row.count)).toEqual([1, 1]);
    expect(cycleLogService(["auth", "api"], "", 1)).toBe("auth");
    expect(cycleLogService(["auth", "api"], "api", 1)).toBe("");
    expect(pickLogService(["auth", "api"], events, 1)).toBe("");
    expect(pickLogService(["auth", "api"], events, 2)).toBe("auth");
    expect(runningLabel(0, 3)).toBe("none started");
    expect(runningLabel(2, 3)).toBe("2/3 running");
  });

  test("log filter catalog keeps extras and totals when the view is filtered", () => {
    const names = ["auth", "api"];
    const events = [
      { timestamp: "t", service: "devctl", source: "devctl", level: "INFO", message: "session", pid: 0, seq: 1 },
      { timestamp: "t", service: "auth", source: "auth", level: "INFO", message: "up", pid: 1, seq: 2 },
      { timestamp: "t", service: "api", source: "api", level: "ERROR", message: "boom", pid: 2, seq: 3 },
    ];
    const catalog = logFilterCatalog(names, events);
    expect(catalog.map((row) => row.name)).toEqual(["", "auth", "api", "devctl"]);
    expect(catalog[0]?.count).toBe(3);
    const view = filterLogs(events, { service: "auth" });
    expect(view.map((ev) => ev.service)).toEqual(["auth"]);
    expect(logFilterCatalog(names, events).map((row) => row.count)).toEqual([3, 1, 1, 1]);
    expect(logFilterCatalog(names, view, ["devctl"]).map((row) => row.name)).toEqual(["", "auth", "api", "devctl"]);
    expect(cycleLogService(["auth", "api", "devctl"], "", 1)).toBe("auth");
    expect(cycleLogService(["auth", "api", "devctl"], "auth", -1)).toBe("");
  });

  test("built-in log services stay in the catalog when the bounded page has no internal events", () => {
    expect(logFilterSources(["api"], [], [...INTERNAL_LOG_SERVICES])).toEqual(["api", "devctl", "mcp", "auth"]);
  });

  test("mergeLoadedPage keeps the page and only strictly-newer already-held events", () => {
    const ev = (seq: number) => ({ timestamp: "t", service: "api", source: "api", level: "INFO", message: `m${seq}`, pid: 1, seq });
    const page = [ev(1), ev(2), ev(3)];
    // "current" simulates events already held client-side before the page
    // resolved: seq 1-3 duplicate what the page now covers, seq 4 arrived
    // live while the fetch was in flight and must not be dropped.
    const current = [ev(1), ev(2), ev(3), ev(4)];
    expect(mergeLoadedPage(current, page).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(mergeLoadedPage(current, []).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  test("prependOlderPage adds older events without duplicating ones already loaded", () => {
    const ev = (seq: number) => ({ timestamp: "t", service: "api", source: "api", level: "INFO", message: `m${seq}`, pid: 1, seq });
    const current = [ev(3), ev(4)];
    expect(prependOlderPage(current, [ev(1), ev(2), ev(3)]).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(prependOlderPage(current, [])).toBe(current);
  });

  test("needsOlderLogPage fires only at the top of a pinned window with more server history", () => {
    expect(needsOlderLogPage(true, 0, true)).toBe(true);
    expect(needsOlderLogPage(false, 0, true)).toBe(false);
    expect(needsOlderLogPage(true, 1, true)).toBe(false);
    expect(needsOlderLogPage(true, 0, false)).toBe(false);
  });

  test("facetServiceCounts fills zero for known services the server hasn't counted yet", () => {
    expect(facetServiceCounts(["auth", "api"], { api: 4 })).toEqual([
      { name: "auth", count: 0 },
      { name: "api", count: 4 },
    ]);
  });

  test("facetFilterCatalog mirrors logFilterCatalog's shape from server-computed counts", () => {
    const names = ["auth", "api"];
    const facets = { total: 5, byService: { auth: 2, api: 2, devctl: 1 }, byLevel: {}, bySource: {} };
    const catalog = facetFilterCatalog(names, facets);
    expect(catalog.map((row) => row.name)).toEqual(["", "auth", "api", "devctl"]);
    expect(catalog.map((row) => row.count)).toEqual([5, 2, 2, 1]);
  });

  test("filterLogs and logViewWindow stay fast over a 50,000-event client buffer", () => {
    // cfg.logs.max_memory_events defaults to 50,000 — even with bounded
    // paging, a long-running TUI session that never clears its view can
    // still accumulate that many events client-side via live streaming, and
    // filterLogs/logViewWindow re-run on every relevant render.
    const services = ["api", "worker", "auth"];
    const events = Array.from({ length: 50_000 }, (_, i) => ({
      timestamp: new Date(2026, 7, 30, 0, 0, 0, i).toISOString(),
      service: services[i % services.length]!,
      source: "stdout",
      level: i % 97 === 0 ? "ERROR" : "INFO",
      message: `line ${i}`,
      pid: 1,
      seq: i + 1,
    }));
    const started = performance.now();
    const filtered = filterLogs(events, { service: "api", search: "line 4" });
    const window = logViewWindow(filtered, false, 0);
    const elapsed = performance.now() - started;
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((ev) => ev.service === "api" && ev.message.includes("4"))).toBe(true);
    expect(window.items.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  });

  test("incremental start keeps already-running services out of new waves", () => {
    const plan = { profile: "backend", steps: [], waves: [["auth"], ["api"], ["worker"]] };
    const snap = {
      services: {
        auth: { state: "RUNNING" },
        api: { state: "RUNNING", health: "HEALTHY" },
        worker: { state: "STOPPED" },
      },
    } as never;
    expect(alreadyUpNames(plan, snap)).toEqual(["auth", "api"]);
    expect(pendingPlanWaves(plan, snap)).toEqual([["worker"]]);
  });

  test("formatStarted joins waves", () => {
    expect(formatStarted({ profile: "backend", steps: [], waves: [["auth"], ["api", "worker"]] })).toBe(
      "Started auth → api → worker",
    );
  });

  test("plan copy says what is needed", () => {
    const plan = {
      profile: "backend",
      steps: [
        { name: "auth", wave: 0, dependencies: [] },
        { name: "api", wave: 1, dependencies: ["auth"] },
      ],
      waves: [["auth"], ["api"]],
    };
    expect(planHeadline(plan, true, "")).toBe("Starting profile backend");
    expect(planRowNote("api", plan, undefined)).toBe("waits for auth");
    expect(planHeadline(plan, false, "auth")).toBe("Start failed on auth");
    expect(planHeadline(plan, true, "", "stop")).toBe("Stopping services");
    expect(planNextAction(true, "", "start")).toContain("healthy");
    expect(planNextAction(true, "", "start")).toContain("esc");
    expect(planNextAction(false, "", "start")).toContain("back to dashboard");
    expect(planNextAction(false, "auth", "start")).toContain("enter or esc");
    expect(focusedServices([], "api")).toEqual(["api"]);
    expect(explicitServices([], ["auth", "api"])).toEqual(["auth", "api"]);
    expect(canStartAll({ services: { api: { state: "FAILED" } } } as never)).toBe(true);
    expect(formatStopped(plan)).toBe("Stopped auth → api");
    expect(
      planRowNote("api", plan, {
        services: {
          auth: { name: "auth", state: "HEALTHY", last_error: "" },
          api: { name: "api", state: "STOPPED", last_error: "" },
        },
      } as never),
    ).toBe("queued");

    expect(waveStatus(["auth"], { services: { auth: { state: "HEALTHY" } } } as never)).toBe("completed");
    expect(waveStatus(["api"], { services: { api: { state: "STARTING" } } } as never)).toBe("active");
    expect(waveStatus(["api"], { services: { api: { state: "UNHEALTHY", health: "UNHEALTHY" } } } as never)).toBe("unhealthy");
    expect(waveStatus(["api"], { services: { api: { state: "FAILED" } } } as never)).toBe("failed");
    expect(waveStatus(["api"], { services: { api: { state: "STOPPED" } } } as never)).toBe("queued");
    expect(waveCardTitle("start", 0, "completed")).toContain("Wave 1 (Start First) · ✓ Completed");
    expect(waveCardTitle("stop", 1, "active")).toContain("Wave 2 · ⏳ In Progress");
    expect(waveCardTitle("start", 1, "unhealthy")).toContain("Wave 2 · ⚠ Unhealthy");
    expect(planRowNote("api", plan, { services: { api: { state: "UNHEALTHY", health: "UNHEALTHY", last_error: "" } } } as never)).toBe(
      "unhealthy — retrying health check",
    );
    expect(planTitle("start", true, "", "backend")).toBe("Starting Pipeline · Profile backend");
    expect(planTitle("stop", false, "")).toBe("Shutdown Complete");
    expect(planActionCopy(true, "").primary).toContain("Working…");

    const prog = planProgress(plan, {
      services: {
        auth: { state: "HEALTHY" },
        api: { state: "STARTING" },
      },
    } as never);
    expect(prog.total).toBe(2);
    expect(prog.ready).toBe(1);
    expect(prog.percent).toBe(50);
    expect(prog.progressBar).toContain("█");
  });

  test("confirm copy covers quit and profile start", () => {
    expect(confirmCopy("quit", "").title).toBe("Quit");
    expect(confirmCopy("quit", "").body).toContain("detach");
    expect(confirmCopy("reload", "api, worker").body).toContain("api, worker");
    expect(confirmCopy("start-profile", "backend").body).toContain("backend");
    expect(confirmCopy("free-port", "", { port: 18000, pid: 99, process: "node" }).title).toBe("Free port 18000");
    expect(confirmCopy("reset-prefs", "").title).toBe("Reset preferences");
    expect(confirmCopy("reset-prefs", "").body).toContain("defaults");
  });

  test("nav cycles skip detail", () => {
    expect(nextScreen("settings")).toBe("dashboard");
    expect(prevScreen("dashboard")).toBe("settings");
    expect(nextScreen("detail")).toBe("dashboard");
    expect(nextScreen("auth")).toBe("credentials");
  });

  test("footer hints are overlay-specific", () => {
    expect(footerHints("dashboard", "confirm").some((h) => h.key === "enter")).toBe(true);
    expect(footerHints("logs", "none").some((h) => h.key === "f")).toBe(true);
    expect(footerHints("logs", "log-details").some((h) => h.key === defaultCopyKeybind())).toBe(true);
    expect(footerHints("settings", "none").some((h) => h.key === "←→" && h.label === "save")).toBe(true);
    expect(footerHints("mcp", "none").some((h) => h.label === "start or copy")).toBe(true);
    expect(footerHints("auth", "none").some((h) => h.key === "/auth login")).toBe(true);
    expect(footerHints("config", "none").some((h) => h.key === "/diff")).toBe(true);
    expect(footerHints("dashboard", "scroll-text").some((h) => h.key === "esc")).toBe(true);
    expect(footerHints("dashboard", "plan").some((h) => h.label.includes("dashboard"))).toBe(true);
    expect(footerHints("dashboard", "help").some((h) => h.key === "j/k")).toBe(true);
    expect(footerHints("config", "config-edit").some((h) => h.key === "ctrl+s")).toBe(true);
  });

  test("grouped commands keep command groups", () => {
    const groups = groupedCommands(allCommands());
    expect(groups.map((g) => g.group)).toEqual(["services", "nav", "logs", "ui", "app"]);
  });

  test("select options stay grouped for the palette", () => {
    const options = commandSelectOptions(allCommands());
    expect(options[0]?.description.startsWith("services")).toBe(true);
    expect(options.some((opt) => opt.value === "reveal")).toBe(true);
  });

  test("footer copy hint follows the configured shortcut", () => {
    expect(footerHints("logs", "none", "cmd+c").some((h) => h.key === "cmd+c")).toBe(true);
    expect(footerHints("logs", "none", "ctrl+c").some((h) => h.key === "ctrl+c")).toBe(true);
  });

  test("logs footer includes search and jump latest", () => {
    const keys = footerHints("logs", "none").map((h) => h.key);
    expect(keys).toContain("f");
    expect(keys).toContain(defaultCopyKeybind());
    expect(keys).toContain("g");
    expect(keys).toContain("←→");
    expect(keys).toContain("1-9");
    expect(keys).toContain("w");
    expect(keys).toContain("j/k");
    expect(keys).toContain("z");
    expect(keys).toContain("/exports");
  });

  test("dashboard footer includes jump to latest logs", () => {
    const keys = footerHints("dashboard", "none").map((h) => h.key);
    expect(keys).toContain("g");
    expect(keys).toContain("z");
    expect(keys).toContain("space");
    expect(keys).toContain(defaultCopyKeybind());
  });

  test("log clipboard text keeps time service level and message", () => {
    const ev = {
      timestamp: "2026-08-30T00:00:00.000Z",
      service: "auth",
      source: "auth",
      level: "INFO",
      message: "ready",
      pid: 1,
      request_id: "req-1",
      identity: "user",
      seq: 1,
    };
    expect(formatLogLine(ev)).toBe("2026-08-30T00:00:00.000Z auth INFO ready");
    expect(formatLogDetails(ev)).toContain("request   req-1");
    expect(formatLogsForClipboard([ev, { ...ev, message: "two" }]).split("\n")).toHaveLength(2);
  });

  test("long log lines wrap on words and fold until expanded", () => {
    const wrapped = wrapLogMessage("ready to accept connections on 127.0.0.1:18000 after warmup", 20);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.every((line) => line.length <= 20)).toBe(true);
    expect(wrapLogMessage("alpha\nbeta", 40)).toEqual(["alpha", "beta"]);
    expect(wrapLogMessage("SUPERCALIFRAGILISTIC", 8)).toEqual(["SUPERCAL", "IFRAGILI", "STIC"]);
    const folded = foldLogLines(wrapped, 20, false);
    expect(folded.folded).toBe(true);
    expect(folded.hidden).toBe(wrapped.length - 1);
    expect(folded.mark).toContain("▸");
    expect(foldLogLines(wrapped, 20, true).folded).toBe(false);
    expect(logRowExpanded("focus", true)).toBe(true);
    expect(logRowExpanded("focus", false)).toBe(false);
    expect(logRowExpanded("all", false)).toBe(true);
    expect(nextLogWrapMode("clip")).toBe("focus");
    expect(nextLogWrapMode("focus")).toBe("all");
    expect(nextLogWrapMode("all")).toBe("clip");
    expect(logWrapLabel("focus")).toBe("wrap selected");
  });

  test("prettyPrintLogRaw indents JSON and falls back to the input on bad JSON", () => {
    expect(prettyPrintLogRaw('{"level":"error","msg":"boom"}')).toBe(JSON.stringify({ level: "error", msg: "boom" }, null, 2));
    expect(prettyPrintLogRaw("not json")).toBe("not json");
  });

  test("log wrap and spans strip ANSI so CSI does not consume width", () => {
    const csi = "\x1b[31mERROR\x1b[0m ready";
    expect(stripAnsi(csi)).toBe("ERROR ready");
    expect(wrapLogMessage(csi, 40)).toEqual(["ERROR ready"]);
    expect(wrapLogMessage(`\x1b[1;32m${"x".repeat(30)}\x1b[0m`, 10).every((line) => line.length <= 10)).toBe(true);
    expect(logMessageSpans(csi).every((span) => !span.text.includes("\x1b"))).toBe(true);
    expect(logMessageSpans(csi).map((span) => span.kind)).toContain("keyword");
    expect(formatLogLine({ timestamp: "t", service: "api", source: "api", level: "INFO", message: csi, pid: 1, request_id: "", identity: "", seq: 1 })).not.toContain("\x1b");
  });

  test("previous session leftover is hidden when it is the live session", () => {
    const leftover = {
      session_id: "sess-1",
      repo_root: "/repo",
      profile: "backend",
      processes: [{ name: "api", pid: 42, command: ["echo"], cwd: ".", startTime: "", ports: {} }],
    };
    expect(previousSessionNote(leftover, "sess-1")).toBeUndefined();
    expect(previousSessionNote(leftover, "sess-2")?.processes[0]?.pid).toBe(42);
    expect(previousSessionNote({ ...leftover, processes: [] }, "sess-2")).toBeUndefined();
  });

  test("log pane width reserves borders padding and scrollbar", () => {
    expect(logPaneInnerWidth(100, 1, false)).toBe(95);
    expect(logPaneInnerWidth(100, 1, true)).toBe(99);
    expect(logPaneInnerWidth(3, 2, false)).toBe(1);
  });

  test("pinned log window stays put while newer events arrive", () => {
    const ev = (n: number) =>
      ({
        timestamp: `2026-08-30T00:00:00.00${n}Z`,
        service: "api",
        source: "api",
        level: "INFO",
        message: `line ${n}`,
        pid: 1,
        seq: n,
      }) as const;
    const first = [0, 1, 2, 3, 4].map(ev);
    const live = logViewWindow(first, false, 0, 3);
    expect(live.items.map((item) => item.message)).toEqual(["line 2", "line 3", "line 4"]);
    expect(live.newer).toBe(0);
    const pinnedStart = logPinStart(first.length, 3);
    const pinned = logViewWindow([...first, ev(5), ev(6)], true, pinnedStart, 3);
    expect(pinned.items.map((item) => item.message)).toEqual(["line 2", "line 3", "line 4"]);
    expect(pinned.newer).toBe(2);
  });

  test("log cursor steps the window when the highlight hits either edge", () => {
    expect(logCursorStep(-1, 3, 4, 0)).toEqual({ selected: 0, startDelta: -1 });
    expect(logCursorStep(3, 3, 0, 2)).toEqual({ selected: 2, startDelta: 1 });
    expect(logCursorStep(1, 3, 4, 0)).toEqual({ selected: 1, startDelta: 0 });
    expect(logCursorStep(-1, 3, 0, 0)).toEqual({ selected: 0, startDelta: 0 });
  });

  test("log cursor pages through deep history by the requested distance", () => {
    expect(logCursorStep(-20, 200, 1000, 500)).toEqual({ selected: 0, startDelta: -20 });
    expect(logCursorStep(219, 200, 1000, 500)).toEqual({ selected: 199, startDelta: 20 });
    expect(logCursorStep(999, 200, 1000, 7)).toEqual({ selected: 199, startDelta: 7 });
  });

  test("clipText reserves a slot without overflow", () => {
    expect(clipText("dashboard live Started auth", 12)).toBe("dashboard l…");
    expect(clipText("ok", 8)).toBe("ok");
    expect(padClip("ports", 9)).toBe("ports    ");
    expect(padClip("identity", 9)).toBe("identity ");
    expect(padClip("verylonglabel", 9)).toBe("verylong…");
  });

  test("service name column grows with the list pane", () => {
    expect(serviceNameColumnWidth(40)).toBeGreaterThan(14);
    expect(serviceNameColumnWidth(80)).toBeGreaterThan(serviceNameColumnWidth(40));
    expect(serviceListPaneWidth(120, ["payment-gateway-worker-east"], false)).toBeGreaterThan(
      serviceListPaneWidth(120, ["api"], false),
    );
    expect(serviceListPaneWidth(80, ["api"], false)).toBeGreaterThanOrEqual(34);
    expect(serviceListPaneWidth(90, ["api"], true)).toBe(90);
    expect(serviceNameColumnWidth(serviceListInnerWidth(serviceListPaneWidth(120, ["billing-console"], false), 1))).toBeGreaterThan(
      "billing-console".length,
    );
    expect(logServiceColumnWidth(80, ["api"])).toBe(10);
    expect(logServiceColumnWidth(80, ["payment-gateway-worker"])).toBe("payment-gateway-worker".length);
    expect(logServiceColumnWidth(40, ["payment-gateway-worker"])).toBeLessThan("payment-gateway-worker".length);
    expect(logMessageWidth({ width: 80, serviceWidth: 10, showTimestamps: false, showMeta: false })).toBeGreaterThan(
      logMessageWidth({ width: 80, serviceWidth: 10, showTimestamps: true, showMeta: true }),
    );
    expect(logMessageWidth({ width: 80, serviceWidth: 10, showTimestamps: true, showMeta: false }) - logMessageWidth({ width: 80, serviceWidth: 10, showTimestamps: false, showMeta: false })).toBe(-LOG_TIME_COL);
    expect(headerStatusChips({ width: HEADER_NARROW_WIDTH - 1, running: 0, total: 3, proxyOn: false, proxyAddress: "", mcpOn: false, adc: false, reveal: false }).some((chip) => chip.label === "!ADC")).toBe(true);
    expect(planOverlayHeight(20, 40)).toBeLessThanOrEqual(14);
    expect(logMessageSpans(`ready "auth" on 18001 ERROR`).map((span) => span.kind)).toEqual([
      "text",
      "string",
      "text",
      "number",
      "text",
      "keyword",
    ]);
  });

  test("visibleHints drops keys that do not fit", () => {
    const hints = footerHints("logs", "none");
    expect(visibleHints(hints, 18).length).toBeLessThan(hints.length);
    expect(visibleHints(hints, 18).length).toBeGreaterThan(0);
  });

  test("slash window keeps the highlighted command visible", () => {
    expect(slashWindowStart(0, 8, 22)).toBe(0);
    expect(slashWindowStart(9, 8, 22)).toBe(2);
    expect(selectedSlashCommand(["a", "b", "c"], 8)).toBe("c");
  });

  test("overlayRect stays inside the terminal chrome", () => {
    const rect = overlayRect(80, 24, 64, 18);
    expect(rect.left + rect.width).toBeLessThanOrEqual(80);
    expect(rect.top + rect.height).toBeLessThanOrEqual(24);
    const bottom = overlayRect(80, 24, 62, 8, "bottom");
    expect(bottom.top + bottom.height).toBeLessThanOrEqual(22);
    const short = overlayRect(40, 6, 64, 18);
    expect(short.top).toBeGreaterThanOrEqual(0);
    expect(short.top + short.height).toBeLessThanOrEqual(6);
    const shortBottom = overlayRect(40, 6, 62, 8, "bottom");
    expect(shortBottom.top + shortBottom.height).toBeLessThanOrEqual(6);
  });

  test("statusChipTone treats successful verbs as success", () => {
    expect(statusChipTone("")).toBe("idle");
    expect(statusChipTone("Started auth → api")).toBe("success");
    expect(statusChipTone("Stopped worker")).toBe("success");
    expect(statusChipTone("Restarted selected services")).toBe("success");
    expect(statusChipTone("Refreshed status and logs")).toBe("success");
    expect(statusChipTone("unknown profile \"gone\"")).toBe("error");
    expect(statusChipTone("api blocked: python3 (pid 12345) is using port 18000 — Open Doctor and press enter to free port 18000")).toBe(
      "error",
    );
    expect(statusChipTone("theme nord  session only")).toBe("warning");
  });

  test("planServices ignores a stale profile name", () => {
    const cfg = defaultConfig();
    cfg.services = { api: emptyService() };
    cfg.profiles = { backend: { services: ["api"], environment: {} } };
    expect(planServices(cfg, ["api"], "missing")).toEqual({ services: ["api"], profile: "" });
    expect(planServices(cfg, [], "backend").profile).toBe("backend");
  });

  test("service inspector labels prefer live ports and fall back cleanly", () => {
    const svc = emptyService();
    svc.command = { args: ["uvicorn", "auth:app"], shell: false };
    svc.ports = [{ name: "http", value: 18000, auto: false }];
    svc.health = { type: "http", url: "/healthz", address: "", command: { args: [], shell: false }, interval_seconds: 0, timeout_seconds: 0, start_period_seconds: 0, unhealthy_threshold: 3, healthy_reset_threshold: 10 };
    svc.identity = { type: "user", mode: "", service_account: "" };
    svc.restart = { policy: "on_failure", max_retries: 3, backoff_seconds: 1 };
    expect(serviceCommandText(svc)).toBe("uvicorn auth:app");
    expect(servicePortsText(svc)).toBe("http:18000");
    expect(servicePortsText(svc, { ports: { http: 18001 } } as never)).toBe("18001");
    expect(serviceHealthText(svc)).toBe("http /healthz");
    expect(serviceIdentityText(svc)).toBe("user");
    expect(serviceIdentityText(svc, { identity: "sa:auth@x" } as never)).toBe("sa:auth@x");
    expect(serviceRestartText(svc)).toBe("on_failure ×3");
    expect(serviceCommandText(emptyService())).toBe("—");
    expect(servicePortsText(emptyService())).toBe("—");
  });

  test("service env entries merge defaults required and stay sorted", () => {
    const svc = emptyService();
    svc.environment = {
      vars: { ZED: "9", TOKEN: "secret" },
      defaults: { REGION: "eu" },
      required: ["TOKEN", "MISSING"],
    };
    const entries = serviceEnvEntries(svc, false, ["TOKEN"], []);
    expect(entries.map((row) => row.key)).toEqual(["MISSING", "REGION", "TOKEN", "ZED"]);
    expect(entries.find((row) => row.key === "TOKEN")?.value).not.toContain("secret");
    expect(entries.find((row) => row.key === "MISSING")?.required).toBe(true);
    expect(envKeyColumnWidth(80)).toBeGreaterThan(envKeyColumnWidth(24));
    expect(envKeyColumnWidth(200)).toBeLessThanOrEqual(28);
    const resolved = serviceEnvEntries(svc, true, ["TOKEN"], [], { TOKEN: "secret", PORT: "18001", REGION: "us" });
    expect(resolved.find((row) => row.key === "PORT")?.value).toBe("18001");
    expect(resolved.find((row) => row.key === "TOKEN")?.value).toBe("secret");
  });

  test("tab window keeps the active item visible when the strip overflows", () => {
    const widths = [12, 10, 8, 12, 14, 8, 9, 9, 10, 10];
    const all = visibleTabRange(widths, 0, 200);
    expect(all.start).toBe(0);
    expect(all.end).toBe(widths.length - 1);
    const mid = visibleTabRange(widths, 6, 36);
    expect(mid.start).toBeLessThanOrEqual(6);
    expect(mid.end).toBeGreaterThanOrEqual(6);
    expect(mid.end - mid.start).toBeLessThan(widths.length - 1);
    const last = visibleTabRange(widths, 9, 24);
    expect(last.end).toBe(9);
    expect(last.start).toBeGreaterThan(0);
    const tight = visibleTabRange([20, 20, 20], 1, 8);
    expect(tight).toEqual({ start: 1, end: 1 });
  });

  test("tab window reserves overflow marks so chips stay inside the budget", () => {
    const chip = 4;
    const widths = [chip, chip, chip, chip, chip];
    const budget = 16;
    const range = visibleTabRange(widths, 2, budget);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(widths.length - 1);
    const chips = widths.slice(range.start, range.end + 1).reduce((sum, w) => sum + w, 0);
    const marks = 2 + 2;
    expect(chips + marks).toBeLessThanOrEqual(budget);
    for (let focus = 0; focus < widths.length; focus += 1) {
      const window = visibleTabRange(widths, focus, budget);
      expect(window.start).toBeLessThanOrEqual(focus);
      expect(window.end).toBeGreaterThanOrEqual(focus);
      const used = widths.slice(window.start, window.end + 1).reduce((sum, w) => sum + w, 0);
      const extra =
        (window.start > 0 ? 2 : 0) + (window.end < widths.length - 1 ? 2 : 0);
      expect(used + extra).toBeLessThanOrEqual(budget);
    }
  });

  test("nav labels compact and map detail to services", () => {
    expect(navTabLabel("dashboard", 120)).toBe("dashboard");
    expect(navTabLabel("dashboard", 70).length).toBeLessThanOrEqual(4);
    expect(navActiveIndex("logs")).toBe(NAV_ITEMS.findIndex((item) => item.id === "logs"));
    expect(navActiveIndex("detail")).toBe(NAV_ITEMS.findIndex((item) => item.id === "services"));
    expect(tabChipWidth("logs")).toBe(6);
  });

  test("first-run setup and letter nav stay on the cycle", () => {
    expect(NAV_ITEMS.some((item) => item.id === "setup")).toBe(true);
    expect(nextScreen("setup")).toBe("stats");
    expect(prevScreen("stats")).toBe("setup");
    expect(NAV_ITEMS.some((item) => item.id === "credentials")).toBe(true);
    expect(footerHints("setup", "none").some((h) => h.key === "esc")).toBe(true);
    expect(footerHints("config", "none").some((h) => h.key === "/reload")).toBe(true);
  });

  test("nav digits cover ten tabs and chrome height matches the toolbar stack", () => {
    expect(NAV_ITEMS).toHaveLength(12);
    expect(navItemForDigit("1")).toBe("dashboard");
    expect(navItemForDigit("8")).toBe("config");
    expect(navItemForDigit("9")).toBe("profiles");
    expect(navItemForDigit("0")).toBe("setup");
    expect(navItemForDigit("a")).toBeUndefined();
    expect(chromeReserved(120)).toBe(8);
    expect(chromeReserved(120, false)).toBe(4);
    expect(CHROME_RESERVED).toBe(9);
    expect(chromeReserved(HEADER_STACK_WIDTH - 1)).toBe(CHROME_RESERVED);
    expect(compactChrome(COMPACT_CHROME_HEIGHT - 1)).toBe(true);
    expect(compactChrome(COMPACT_CHROME_HEIGHT)).toBe(false);
  });

  test("renderBar clamps ratios and fills proportionally", () => {
    expect(renderBar(0, 10)).toBe("░".repeat(10));
    expect(renderBar(1, 10)).toBe("█".repeat(10));
    expect(renderBar(0.5, 10)).toBe("█████░░░░░");
    expect(renderBar(2, 10)).toBe("█".repeat(10));
    expect(renderBar(-1, 10)).toBe("░".repeat(10));
    expect(renderBar(Number.NaN, 10)).toBe("░".repeat(10));
  });

  test("formatUptime renders human-friendly durations", () => {
    expect(formatUptime(500)).toBe("< 1s");
    expect(formatUptime(45_000)).toBe("45s");
    expect(formatUptime(125_000)).toBe("2m 05s");
    expect(formatUptime(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
    expect(formatUptime(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
  });

  test("formatMemoryKB scales through K/M/G", () => {
    expect(formatMemoryKB(512)).toBe("512K");
    expect(formatMemoryKB(2048)).toBe("2M");
    expect(formatMemoryKB(1_536_000)).toBe("1.5G");
    expect(formatMemoryKB(Number.NaN)).toBe("—");
    expect(formatMemoryKB(-1)).toBe("—");
  });

  test("formatCpuPercent renders one decimal place", () => {
    expect(formatCpuPercent(0)).toBe("0.0%");
    expect(formatCpuPercent(12.34)).toBe("12.3%");
    expect(formatCpuPercent(Number.NaN)).toBe("—");
    expect(formatCpuPercent(-1)).toBe("—");
  });

  test("screenListCount clamps the shared cursor to the active list", () => {
    const counts = { doctor: 8, settings: 7, profiles: 2, services: 3 };
    expect(screenListCount("doctor", counts)).toBe(8);
    expect(screenListCount("services", counts)).toBe(3);
    expect(screenListCount("logs", counts)).toBe(0);
    expect(screenListCount("logs", { ...counts, logs: 12 })).toBe(12);
    // The mcp screen's length depends on how many MCP tools exist, so only
    // its caller knows it; screenListCount has no fallback of its own.
    expect(screenListCount("mcp", counts)).toBe(0);
    expect(screenListCount("mcp", { ...counts, mcp: 19 })).toBe(19);
    expect(screenListCount("setup", counts)).toBe(9);
  });

  test("googleProjectDisplay prefers google.project_id from config", () => {
    expect(
      googleProjectDisplay(
        { google: { project_id: "from-yaml" } },
        { project: "from-identity", project_source: "gcloud configuration" },
        { projectID: "from-adc", projectSource: "application default credentials" },
      ),
    ).toEqual({ project: "from-yaml", source: "configuration" });
    expect(googleProjectDisplay(undefined, { project: "from-identity", project_source: "gcloud configuration" }, undefined)).toEqual({
      project: "from-identity",
      source: "gcloud configuration",
    });
  });

  test("statusStripChips adapts to pane width and prevents overflow", () => {
    const wide = statusStripChips("dev@company.com", "gcp-proj", 100, 80);
    expect(wide).toHaveLength(3);
    expect(wide[0]?.label).toContain("dev@company.com");
    expect(wide[1]?.label).toBe("gcp-proj");
    expect(wide[2]?.label).toBe("logs 100");

    const medium = statusStripChips("amr.longemailaddress@organization.enterprise.com", "gcp-proj-12345", 2500, 38);
    expect(medium.length).toBeLessThanOrEqual(3);
    const totalChars = medium.reduce((sum, chip) => sum + chip.label.length + 2, 0);
    expect(totalChars).toBeLessThanOrEqual(38);

    const veryNarrow = statusStripChips("user@test.com", "proj", 10, 24);
    expect(veryNarrow.length).toBe(2);
    const narrowChars = veryNarrow.reduce((sum, chip) => sum + chip.label.length + 2, 0);
    expect(narrowChars).toBeLessThanOrEqual(24);
  });

  test("service fleet buckets are exclusive and do not subtract healthy from stopped", () => {
    const names = ["api", "auth", "worker", "proxy", "idle"];
    const snap = {
      services: {
        api: { state: "RUNNING", health: "HEALTHY" },
        auth: { state: "RUNNING", health: "HEALTHY" },
        worker: { state: "STARTING", health: "UNKNOWN" },
        proxy: { state: "FAILED", health: "UNHEALTHY" },
      },
    } as never;
    const fleet = serviceFleetStats(names, snap);
    expect(fleet).toEqual({
      total: 5,
      live: 3,
      running: 2,
      starting: 1,
      healthy: 2,
      failed: 1,
      stopping: 0,
      stopped: 1,
    });
    expect(fleet.running + fleet.starting + fleet.stopping + fleet.failed + fleet.stopped).toBe(fleet.total);
  });

  test("stale healthy health does not count a stopped process as running", () => {
    expect(isActiveRuntime({ state: "STOPPED", health: "HEALTHY" } as never)).toBe(false);
    expect(isActiveRuntime({ state: "RUNNING", health: "UNHEALTHY" } as never)).toBe(true);
    expect(isActiveRuntime({ state: "RESTARTING", health: "UNKNOWN" } as never)).toBe(true);
    expect(countRunning({ services: { api: { state: "STOPPED", health: "HEALTHY" } } } as never)).toEqual({ running: 0, total: 1 });
    expect(countRunning({ services: { api: { state: "RUNNING" }, extra: { state: "STOPPED" } } } as never, ["api"])).toEqual({
      running: 1,
      total: 1,
    });
  });

  test("system stat helpers clamp and label pressure", () => {
    expect(memoryUsedKB(16_000, 4_000)).toBe(12_000);
    expect(memoryUsedKB(100, 200)).toBe(0);
    expect(memoryUsedKB(Number.NaN, 10)).toBe(0);
    expect(loadPerCpu(4, 8)).toBe(0.5);
    expect(loadPerCpu(2, 0)).toBe(0);
    expect(loadTone(2, 8)).toBe("success");
    expect(loadTone(8, 8)).toBe("warning");
    expect(loadTone(16, 8)).toBe("error");
    expect(leftoverTone(3_000, 10_000)).toBe("success");
    expect(leftoverTone(1_500, 10_000)).toBe("warning");
    expect(leftoverTone(500, 10_000)).toBe("error");
    expect(memoryTone(8_500, 10_000)).toBe("warning");
    expect(memoryTone(9_500, 10_000)).toBe("error");
    expect(formatLoadAvg(1.234)).toBe("1.23");
    expect(formatLoadAvg(-1)).toBe("—");
    expect(formatRatioPercent(0.756)).toBe("76%");
    expect(runtimeUptime(undefined)).toBe("—");
    expect(runtimeUptime({ startTime: new Date(1_000).toISOString() } as never, 46_000)).toBe("45s");
    expect(topLogSources({ api: 2, auth: 5, zed: 5 })).toEqual([
      ["auth", 5],
      ["zed", 5],
      ["api", 2],
    ]);
    expect(statsServiceColumns(40).health).toBe(false);
    expect(statsServiceColumns(90).pid).toBe(false);
    expect(statsServiceColumns(100).pid).toBe(true);
    expect(statsServiceColumns(100).name).toBeGreaterThan(10);
    expect(statsPaneWidth(80, 1)).toBe(71);
    expect(statsPaneWidth(80, 2)).toBeLessThan(statsPaneWidth(80, 1));
    const wideFacts = factTableColumns(
      [
        { what: "RAM leftover", reading: "12.4G of 36.0G", meaning: "RAM the computer can still give out" },
        { what: "Google account", reading: "not signed in", meaning: "no Google user for this session" },
      ],
      80,
    );
    expect(wideFacts.reading).toBeGreaterThanOrEqual("12.4G of 36.0G".length);
    expect(wideFacts.reading).toBeGreaterThanOrEqual("not signed in".length);
    expect(wideFacts.what).toBeGreaterThanOrEqual("Google account".length);
    expect(wideFacts.meter).toBe(0);
    expect(wideFacts.what + wideFacts.reading + wideFacts.meaning + STATS_FACT_GAP * 2).toBeLessThanOrEqual(80);
    const metered = factTableColumns([{ what: "CPU work", reading: "not busy", meaning: "fine", meter: { ratio: 0.3, label: "30%" } }], 80);
    expect(metered.meter).toBeGreaterThan(0);
    expect(metered.what + metered.reading + metered.meter + metered.meaning + STATS_FACT_GAP * 3).toBeLessThanOrEqual(80);
  });

  test("stats copy uses words a person can act on", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(loadCopy(1, 8).reading).toBe("not busy");
    expect(loadCopy(1, 8).meaning).toContain("under 8 is fine");
    expect(loadCopy(1, 8).meter?.label).toBe("13%");
    expect(loadCopy(16, 8).reading).toBe("overloaded");
    expect(loadCopy(16, 8).meter?.ratio).toBe(1);
    expect(leftoverCopy(8_192, 16_384).what).toBe("RAM leftover");
    expect(leftoverCopy(8_192, 16_384).meaning).toContain("still give out");
    expect(leftoverCopy(8_192, 16_384).meter?.label).toBe("50%");
    expect(serviceStatusLabel({ state: "HEALTHY" } as never)).toBe("up");
    expect(serviceStatusLabel({ state: "FAILED" } as never)).toBe("crashed");
    expect(serviceCheckLabel({ state: "RUNNING", health: "HEALTHY" } as never)).toBe("ready");
    expect(serviceCheckLabel({ state: "STOPPED", health: "UNKNOWN" } as never)).toBe("—");
    expect(usesTrafficHealth({ health: { type: "http" } } as never)).toBe(true);
    expect(usesTrafficHealth({ health: { type: "process" } } as never)).toBe(false);
    const facts = fleetFacts(
      { total: 4, live: 2, running: 2, starting: 0, healthy: 1, failed: 1, stopping: 0, stopped: 1 },
      true,
    );
    expect(facts.map((row) => row.what)).toEqual(["Started", "Ready", "Crashed", "Not started"]);
    expect(facts.find((row) => row.what === "Ready")?.reading).toBe("1");
    expect(fleetFacts({ total: 1, live: 1, running: 1, starting: 0, healthy: 1, failed: 0, stopping: 0, stopped: 0 }, false).map((row) => row.what)).toEqual([
      "Started",
      "Crashed",
      "Not started",
    ]);
  });
});

describe("reloadFailureMessage", () => {
  test("uses the event's error, falling back when missing or malformed", () => {
    expect(reloadFailureMessage({ type: ConfigurationReloadFailed, timestamp: "", payload: { error: "invalid YAML" } })).toBe("invalid YAML");
    expect(reloadFailureMessage({ type: ConfigurationReloadFailed, timestamp: "" })).toBe("configuration reload failed");
    expect(reloadFailureMessage({ type: ConfigurationReloadFailed, timestamp: "", payload: { error: 42 } })).toBe("configuration reload failed");
    expect(reloadFailureMessage({ type: ConfigurationReloadFailed, timestamp: "", payload: { error: "" } })).toBe("configuration reload failed");
  });
});
