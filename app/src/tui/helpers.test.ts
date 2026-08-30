import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../config/types.ts";
import { alreadyUpNames, canStartAll, CHROME_RESERVED, chromeReserved, clipText, commandSelectOptions, compactChrome, COMPACT_CHROME_HEIGHT, confirmCopy, cycleLogService, defaultProfileName, envKeyColumnWidth, explicitServices, filterLogs, focusedServices, foldLogLines, formatLogDetails, formatLogLine, formatLogsForClipboard, formatStarted, formatStopped, footerHints, groupedCommands, HEADER_NARROW_WIDTH, HEADER_STACK_WIDTH, headerStatusChips, logCursorStep, logFilterCatalog, logMessageSpans, logMessageWidth, LOG_TIME_COL, logPinStart, logRowExpanded, logServiceColumnWidth, logServiceCounts, logViewWindow, logWrapLabel, NAV_ITEMS, navActiveIndex, navItemForDigit, navTabLabel, nextLogWrapMode, nextScreen, noneStarted, overlayRect, padClip, pendingPlanWaves, pickLogService, planHeadline, planNextAction, planOverlayHeight, planRowNote, planServices, prevScreen, runningLabel, screenListCount, selectedSlashCommand, serviceCommandText, serviceEnvEntries, serviceHealthText, serviceIdentityText, serviceListInnerWidth, serviceListPaneWidth, serviceNameColumnWidth, servicePortsText, serviceRestartText, slashWindowStart, statusChipTone, tabChipWidth, visibleHints, visibleLogs, visibleTabRange, wrapLogMessage } from "./helpers.ts";
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

  test("visibleLogs hides history while services are stopped", () => {
    const events = [
      {
        timestamp: "2026-08-30T00:00:00.000Z",
        service: "devctl",
        source: "devctl",
        level: "INFO",
        message: "supervisor started session=abc",
        pid: 0,
      },
    ];
    expect(visibleLogs(events, undefined)).toEqual([]);
    expect(visibleLogs(events, { services: { api: { state: "STOPPED" } } } as never)).toEqual([]);
    const later = { ...events[0]!, timestamp: "2026-08-30T00:01:00.000Z", service: "api", message: "ready" };
    const running = { services: { api: { state: "RUNNING" }, auth: { state: "RUNNING" } } } as never;
    expect(visibleLogs([...events, later], running)).toHaveLength(2);
    expect(visibleLogs([...events, later], running, "2026-08-30T00:00:30.000Z")).toEqual([later]);
  });

  test("log filters keep all services until a chip is chosen", () => {
    const events = [
      { timestamp: "t", service: "auth", source: "auth", level: "INFO", message: "up", pid: 1 },
      { timestamp: "t", service: "api", source: "api", level: "ERROR", message: "boom", pid: 2 },
    ];
    expect(filterLogs(events, {}).map((ev) => ev.service)).toEqual(["auth", "api"]);
    expect(filterLogs(events, { service: "api" }).map((ev) => ev.service)).toEqual(["api"]);
    expect(filterLogs(events, { errorOnly: true }).map((ev) => ev.service)).toEqual(["api"]);
    expect(filterLogs(events, { search: "up" }).map((ev) => ev.service)).toEqual(["auth"]);
    expect(filterLogs(events, { services: ["api", "auth"], regex: true, search: "^b" }).map((ev) => ev.service)).toEqual(["api"]);
    expect(filterLogs(events, { source: "auth" }).map((ev) => ev.service)).toEqual(["auth"]);
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
      { timestamp: "t", service: "devctl", source: "devctl", level: "INFO", message: "session", pid: 0 },
      { timestamp: "t", service: "auth", source: "auth", level: "INFO", message: "up", pid: 1 },
      { timestamp: "t", service: "api", source: "api", level: "ERROR", message: "boom", pid: 2 },
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
    expect(footerHints("dashboard", "plan").some((h) => h.label.includes("dashboard"))).toBe(true);
    expect(footerHints("dashboard", "help").some((h) => h.key === "j/k")).toBe(true);
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

  test("pinned log window stays put while newer events arrive", () => {
    const ev = (n: number) =>
      ({
        timestamp: `2026-08-30T00:00:00.00${n}Z`,
        service: "api",
        source: "api",
        level: "INFO",
        message: `line ${n}`,
        pid: 1,
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
    svc.health = { type: "http", url: "/healthz", address: "", command: { args: [], shell: false }, interval_seconds: 0, timeout_seconds: 0 };
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
    expect(nextScreen("setup")).toBe("settings");
    expect(prevScreen("settings")).toBe("setup");
    expect(NAV_ITEMS.some((item) => item.id === "credentials")).toBe(true);
    expect(footerHints("setup", "none").some((h) => h.key === "esc")).toBe(true);
    expect(footerHints("config", "none").some((h) => h.key === "/reload")).toBe(true);
  });

  test("nav digits cover ten tabs and chrome height matches the toolbar stack", () => {
    expect(NAV_ITEMS).toHaveLength(11);
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

  test("screenListCount clamps the shared cursor to the active list", () => {
    const counts = { doctor: 8, settings: 7, profiles: 2, services: 3 };
    expect(screenListCount("doctor", counts)).toBe(8);
    expect(screenListCount("services", counts)).toBe(3);
    expect(screenListCount("logs", counts)).toBe(0);
    expect(screenListCount("logs", { ...counts, logs: 12 })).toBe(12);
    expect(screenListCount("mcp", counts)).toBe(6);
    expect(screenListCount("setup", counts)).toBe(9);
  });
});
