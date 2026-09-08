import type { CliRenderer } from "@opentui/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useRef } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { checkUpdate, formatUpdateStatus } from "../../../update.ts";
import { versionLine } from "../../../version.ts";
import { parseExecArgs, type CommandSpec } from "../commands.ts";
import { formatConfigDiffText } from "../config-view.ts";
import { logWrapLabel, nextLogWrapMode } from "../helpers/logs.ts";
import { explicitServices } from "../helpers/services.ts";
import { withSuspendedRenderer } from "../suspend.ts";
import { THEME_NAMES } from "../themes.ts";
import { type ConfirmKind, type Overlay, type Screen } from "../types.ts";
import type { TuiWorkspace } from "../workspace.ts";
import type { useDiagnostics } from "./use-diagnostics.ts";
import type { useLifecycle } from "./use-lifecycle.ts";
import type { useLogView } from "./use-log-view.ts";

const COMMAND_LOCK_MS = 50;

type Options = {
  lifecycleActions: Pick<ReturnType<typeof useLifecycle>, "beginStart" | "beginStop" | "beginRestart">;
  diagnostics: Pick<ReturnType<typeof useDiagnostics>, "refreshAuth" | "setGoogle">;
  logView: Pick<ReturnType<typeof useLogView>, "setLogService" | "setLogsFullscreen" | "setPaused" | "setErrorOnly" | "toggleSystemLogs" | "clearLogs" | "logWrap" | "setLogWrap" | "logServices" | "errorOnly" | "logLevel" | "logSearch" | "logRegex" | "logSource" | "filteredLogs" | "setLogRegex" | "setLogSince" | "setLogUntil" | "setLogs">;
  workspace: Pick<TuiWorkspace, "loginGoogle" | "detectGoogle" | "logoutGoogle" | "bootstrapLogPath" | "fileExists" | "readTextFile" | "resolveExportPath" | "writeLogExport" | "exportsDir" | "openInFileManager" | "listSessions" | "loadSessionEvents">;
  setOverlay: Dispatch<SetStateAction<Overlay>>;
  setQuery: Dispatch<SetStateAction<string>>;
  checked: string[];
  setConfirmKind: Dispatch<SetStateAction<ConfirmKind>>;
  setStatus: Dispatch<SetStateAction<string>>;
  persistTheme: (name: string) => void;
  setPaletteIndex: Dispatch<SetStateAction<number>>;
  themeName: string;
  setScreen: Dispatch<SetStateAction<Screen>>;
  setSelected: Dispatch<SetStateAction<number>>;
  screen: Screen;
  renderer: CliRenderer;
  cfg: DevctlConfig | undefined;
  setScrollText: Dispatch<SetStateAction<{ title: string; body: string; } | undefined>>;
  reveal: boolean;
  controller: Controller | undefined;
  refresh: () => Promise<StatusSnapshot | undefined>;
  profile: string;
  setReveal: Dispatch<SetStateAction<boolean>>;
  resolveEnvironment: (service: string) => Promise<void>;
  openDetail: (name: string) => void;
  copyVisibleLogs: (note?: string) => Promise<void>;
  lastExportPath: RefObject<string>;
  openConfigBuffer: () => void;
};

export function useCommandDispatcher({
  setOverlay,
  setQuery,
  checked,
  setConfirmKind,
  setStatus,
  persistTheme,
  setPaletteIndex,
  themeName,
  setScreen,
  setSelected,
  screen,
  renderer,
  cfg,
  setScrollText,
  reveal,
  controller,
  refresh,
  profile,
  setReveal,
  resolveEnvironment,
  openDetail,
  copyVisibleLogs,
  lastExportPath,
  openConfigBuffer,
  workspace,
  logView,
  diagnostics,
  lifecycleActions,
}: Options) {

  const {
    loginGoogle,
    detectGoogle,
    logoutGoogle,
    bootstrapLogPath,
    fileExists,
    readTextFile,
    resolveExportPath,
    writeLogExport,
    exportsDir,
    openInFileManager,
    listSessions,
    loadSessionEvents,
  } = workspace;
  const {
    setLogService,
    setLogsFullscreen,
    setPaused,
    setErrorOnly,
    toggleSystemLogs,
    clearLogs,
    logWrap,
    setLogWrap,
    logServices,
    errorOnly,
    logLevel,
    logSearch,
    logRegex,
    logSource,
    filteredLogs,
    setLogRegex,
    setLogSince,
    setLogUntil,
    setLogs,
  } = logView;
  const { refreshAuth, setGoogle } = diagnostics;
  const { beginStart, beginStop, beginRestart } = lifecycleActions;
  const commandBusy = useRef(false);

  const runCommand = useCallback(
    async (spec: CommandSpec, args: string[]) => {
      if (commandBusy.current) {
        return;
      }
      commandBusy.current = true;
      if (spec.name !== "start" && spec.name !== "stop" && spec.name !== "restart") {
        setOverlay("none");
      }
      setQuery("");
      const targets = explicitServices(args, checked);
      try {
        switch (spec.name) {
          case "exit":
            setConfirmKind("quit");
            setOverlay("confirm");
            return;
          case "help":
            setOverlay("help");
            return;
          case "version":
            setStatus(versionLine());
            void checkUpdate()
              .then((result) => setStatus(formatUpdateStatus(result)))
              .catch((err: unknown) => setStatus(humanMessage(err)));
            return;
          case "update":
            setStatus("checking for update…");
            void checkUpdate()
              .then((result) => setStatus(formatUpdateStatus(result)))
              .catch((err: unknown) => setStatus(humanMessage(err)));
            return;
          case "themes":
            if (args[0]) {
              persistTheme(args[0]);
              return;
            }
            setPaletteIndex(Math.max(0, THEME_NAMES.indexOf(themeName as (typeof THEME_NAMES)[number])));
            setQuery("");
            setOverlay("themes");
            return;
          case "settings":
            setScreen("settings");
            setSelected(0);
            return;
          case "dashboard":
          case "services":
            setScreen(spec.name);
            return;
          case "logs":
            if (args[0]) {
              setLogService(args[0]);
            }
            setScreen("logs");
            return;
          case "fullscreen":
            setScreen("logs");
            setLogsFullscreen((current) => (screen === "logs" ? !current : true));
            return;
          case "auth": {
            const action = (args[0] ?? "").toLowerCase();
            if (action === "refresh") {
              setScreen("auth");
              await refreshAuth();
              return;
            }
            if (action === "login") {
              setScreen("auth");
              setStatus("starting gcloud ADC login…");
              try {
                await withSuspendedRenderer(renderer, () => loginGoogle());
                setGoogle(await detectGoogle(cfg?.google.project_id ?? ""));
                await refreshAuth();
                setStatus("ADC login complete");
              } catch (err) {
                setStatus(humanMessage(err));
              }
              return;
            }
            if (action === "logout") {
              setScreen("auth");
              setStatus("revoking ADC…");
              try {
                await logoutGoogle();
                setGoogle(await detectGoogle(cfg?.google.project_id ?? ""));
                await refreshAuth();
                setStatus("ADC revoked");
              } catch (err) {
                setStatus(humanMessage(err));
              }
              return;
            }
            setScreen("auth");
            return;
          }
          case "credentials":
          case "proxy":
          case "mcp":
          case "config":
          case "profiles":
          case "setup":
            setScreen(spec.name);
            return;
          case "diff":
            if (!cfg) {
              setStatus("no configuration loaded");
              return;
            }
            setScrollText({ title: "config sources", body: formatConfigDiffText(cfg, reveal) });
            setOverlay("scroll-text");
            return;
          case "daemon": {
            const root = cfg?.repoRoot;
            if (!root) {
              setStatus("no repository");
              return;
            }
            const path = bootstrapLogPath(root);
            if (!fileExists(path)) {
              setStatus("no daemon bootstrap log yet for this repository");
              return;
            }
            setScrollText({ title: "daemon bootstrap", body: readTextFile(path) });
            setOverlay("scroll-text");
            return;
          }
          case "reload":
            if (!controller) {
              return;
            }
            void controller.reload().then((result) => {
              setStatus(result.restart_required.length === 0 ? "Configuration reloaded" : `Reload requires restart: ${result.restart_required.join(", ")}`);
              if (result.restart_required.length > 0) {
                setConfirmKind("reload");
                setOverlay("confirm");
              }
              void refresh();
            });
            return;
          case "doctor":
            setScreen("doctor");
            return;
          case "stats":
            setScreen("stats");
            return;
          case "start":
            await beginStart(targets, profile);
            return;
          case "stop":
            await beginStop(targets);
            return;
          case "restart":
            await beginRestart(targets, profile);
            return;
          case "run": {
            const name = args[0] ?? "";
            if (!controller || !name) {
              setStatus(name ? "no daemon attached" : "usage: /run <task>");
              return;
            }
            try {
              const result = await controller.runTask(name);
              setLogService(`task:${name}`);
              setScreen("logs");
              setStatus(`task ${name} exited ${result.code}`);
            } catch (err) {
              setLogService(`task:${name}`);
              setScreen("logs");
              throw err;
            }
            return;
          }
          case "exec": {
            const parsed = parseExecArgs(args);
            if (!controller || !parsed.service) {
              setStatus(parsed.service ? "no daemon attached" : "usage: /exec <service> -- <command…>");
              return;
            }
            if (parsed.printEnv) {
              if (!cfg?.services[parsed.service]) {
                setStatus(`unknown service ${parsed.service}`);
                return;
              }
              if (parsed.reveal) {
                setReveal(true);
              }
              setStatus(`Resolving environment for ${parsed.service}…`);
              try {
                await resolveEnvironment(parsed.service);
                openDetail(parsed.service);
                setStatus(`Resolved environment for ${parsed.service}`);
              } catch (err) {
                openDetail(parsed.service);
                setStatus(humanMessage(err));
              }
              return;
            }
            if (parsed.command.length === 0) {
              setStatus("usage: /exec <service> -- <command…>");
              return;
            }
            try {
              const result = await controller.execService(parsed.service, parsed.command);
              setLogService(`${parsed.service}:exec`);
              setScreen("logs");
              setStatus(`${parsed.service}:exec exited ${result.code}`);
            } catch (err) {
              setLogService(`${parsed.service}:exec`);
              setScreen("logs");
              throw err;
            }
            return;
          }
          case "refresh":
            if (screen === "auth") {
              await refreshAuth();
              return;
            }
            await refresh();
            setStatus("Refreshed status and logs");
            return;
          case "pause":
            setPaused((v) => !v);
            setScreen("logs");
            return;
          case "filter":
            setErrorOnly((v) => !v);
            setScreen("logs");
            return;
          case "system":
            toggleSystemLogs();
            setScreen("logs");
            return;
          case "clear":
            clearLogs();
            return;
          case "reveal": {
            const next = !reveal;
            setReveal(next);
            setStatus(next ? "Secrets visible this session" : "Secrets hidden");
            return;
          }
          case "wrap": {
            const next = nextLogWrapMode(logWrap);
            setLogWrap(next);
            setStatus(`Log ${logWrapLabel(next)}`);
            return;
          }
          case "copy":
            await copyVisibleLogs();
            return;
          case "export": {
            const dest = resolveExportPath(args[0]);
            if (controller) {
              await controller.logs({
                export: dest,
                services: logServices,
                level: errorOnly ? "ERROR" : logLevel,
                search: logSearch,
                regex: logRegex,
                source: logSource,
              });
            } else {
              // Same reasoning as copyVisibleLogs: reuse the already-filtered
              // list instead of reconstructing the filter, so a local-only
              // export (no daemon attached) matches every active filter too.
              writeLogExport(dest, filteredLogs);
            }
            lastExportPath.current = dest;
            setStatus(`Exported ${dest}`);
            return;
          }
          case "exports": {
            const target = lastExportPath.current || exportsDir();
            openInFileManager(target);
            setStatus(`Opened ${exportsDir()}`);
            return;
          }
          case "regex":
            setLogRegex((v) => !v);
            setStatus(logRegex ? "Substring search" : "Regex search");
            return;
          case "since":
            setLogSince(args[0] || new Date(Date.now() - 3_600_000).toISOString());
            setStatus(`Logs since ${args[0] || "1h"}`);
            return;
          case "until":
            setLogUntil(args[0] || new Date().toISOString());
            setStatus(`Logs until ${args[0] || "now"}`);
            return;
          case "history": {
            const sessions = listSessions();
            const pick = args[0] || sessions[0];
            if (!pick) {
              setStatus("No persisted log sessions");
              return;
            }
            setLogs(loadSessionEvents(pick));
            setStatus(`Loaded session ${pick}`);
            return;
          }
          case "buffer":
            openConfigBuffer();
            return;
          case "edit": {
            if (!cfg) {
              return;
            }
            const editor = process.env.DEVCTL_EDITOR || process.env.EDITOR;
            const cmd = editor
              ? [editor, cfg.configPath]
              : process.platform === "darwin"
                ? ["open", cfg.configPath]
                : ["xdg-open", cfg.configPath];
            Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
            setStatus(`Opened ${cfg.configPath} in ${cmd[0]}. Run /reload after saving.`);
            return;
          }
          default:
            setStatus(`/${spec.name}`);
        }
      } catch (err) {
        setStatus(humanMessage(err));
      } finally {
        setTimeout(() => {
          commandBusy.current = false;
        }, COMMAND_LOCK_MS);
      }
    },
    [beginRestart, beginStart, beginStop, checked, cfg, clearLogs, controller, copyVisibleLogs, errorOnly, filteredLogs, logLevel, logRegex, logSearch, logServices, logSource, logWrap, openConfigBuffer, openDetail, persistTheme, profile, refresh, refreshAuth, renderer, reveal, screen, themeName, toggleSystemLogs],
  );
  return { runCommand };
}
