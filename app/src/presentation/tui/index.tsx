import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ClientRuntime, Controller } from "../../application/client-runtime.ts";
import { createTuiWorkspace } from "./workspace.ts";
import { humanMessage, isKind, KindConfiguration, KindConfigurationMissing } from "../../shared/errors.ts";
import { App } from "./App.tsx";
import { holdStderrForTui, silenceGcpMetadataWarnings } from "../../shared/warnings.ts";
import { installTerminalRestoreOnExit, restoreTerminalModes } from "../../shared/terminal-restore.ts";
import { keepPerformanceTimelineEmpty } from "./helpers/performance-timeline.ts";
import { openTuiClipboard } from "./clipboard.ts";
import { detachOnSignal, formatTuiFailure, signalExitCode } from "./shutdown.ts";

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

export async function runTuiWithController(client: ClientRuntime, controller: Controller): Promise<void> {
  const tui = client.loadTuiConfig(controller.cfg.repoRoot, controller.cfg.ui.keymap);
  await renderApp(client, controller, tui);
}

export async function runTui(client: ClientRuntime, configPath: string): Promise<void> {
  let controller: Controller | undefined;
  let bootError: string | undefined;
  let bootErrorMissing = false;
  let bootErrorConfig = false;
  try {
    controller = await client.openTui("", configPath);
  } catch (err) {
    bootError = humanMessage(err);
    bootErrorMissing = isKind(err, KindConfigurationMissing);
    bootErrorConfig = isKind(err, KindConfiguration);
  }
  const tui = client.loadTuiConfig(controller?.cfg.repoRoot ?? process.cwd(), controller?.cfg.ui.keymap);
  await renderApp(client, controller, tui, bootError, bootErrorMissing, bootErrorConfig);
}

export async function renderApp(
  client: ClientRuntime,
  controller: Controller | undefined,
  tui = client.loadTuiConfig(controller?.cfg.repoRoot ?? process.cwd(), controller?.cfg.ui.keymap),
  bootError?: string,
  bootErrorMissing = false,
  bootErrorConfig = false,
): Promise<void> {
  silenceGcpMetadataWarnings();
  installTerminalRestoreOnExit();
  const restoreStderr = holdStderrForTui();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: tui.mouse,
    useKittyKeyboard: {},
  });
  const clipboard = openTuiClipboard(renderer);
  const root = createRoot(renderer);
  const stopTimelineClear = keepPerformanceTimelineEmpty();
  let terminalBackground: string | null = null;
  try {
    terminalBackground = (await renderer.getPalette({ timeout: 120, size: 16 })).defaultBackground;
  } catch {
    // Keep the explicit theme background when the terminal does not answer OSC palette queries.
  }
  await new Promise<void>((resolve) => {
    let shutdownStarted = false;
    let shutdownCode = 0;
    let leaving = false;
    const leaveTty = async (): Promise<void> => {
      if (leaving) {
        return;
      }
      leaving = true;
      try {
        try {
          root.unmount();
        } catch {
          // The tree may already be gone after a failed commit.
        }
        stopTimelineClear();
        restoreStderr();
        try {
          await clipboard.dispose();
        } catch {
          // A clipboard worker must not keep the terminal in the TUI's modes.
        }
        try {
          renderer.destroy();
          await renderer.closed;
        } catch {
          // A late close already tried to restore. Write the sequence again
          // when that promise rejects, so a dropped queue cannot leave mouse
          // tracking on.
          restoreTerminalModes();
        }
      } finally {
        resolve();
        // The renderer keeps stdin open, so the loop does not drain on its
        // own. controller.close() has finished by the time we get here.
        process.exit(shutdownCode);
      }
    };
    const markShutdown = (code: number): boolean => {
      if (shutdownStarted) {
        return false;
      }
      shutdownStarted = true;
      shutdownCode = code;
      return true;
    };
    const closeThenLeave = (detach: boolean | undefined): void => {
      if (!controller) {
        void leaveTty();
        return;
      }
      void controller.close({ detach, shutdownSupervisor: true }).finally(() => {
        void leaveTty();
      });
    };
    const quit = (detach?: boolean): void => {
      if (!markShutdown(0)) {
        return;
      }
      closeThenLeave(detach);
    };
    const down = (keepServices: boolean): void => {
      if (!markShutdown(0)) {
        return;
      }
      if (!controller) {
        void leaveTty();
        return;
      }
      void controller
        .shutdown({ stopServices: !keepServices })
        .then(() => controller?.close({ detach: true }))
        .finally(() => {
          void leaveTty();
        });
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      const code = signalExitCode(signal);
      const detach = detachOnSignal(signal, controller?.cfg.shutdown.stop_services_on_exit);
      if (!markShutdown(code)) {
        shutdownCode = code;
        void leaveTty();
        return;
      }
      closeThenLeave(detach);
    };
    for (const signal of TERMINATION_SIGNALS) {
      process.on(signal, onSignal);
    }
    const onFatal = (reason: unknown): void => {
      try {
        process.stderr.write(`\ndevctl: TUI terminated unexpectedly\n${formatTuiFailure(reason)}\n`);
      } catch {
        // stderr already gone
      }
      if (!markShutdown(1)) {
        return;
      }
      closeThenLeave(true);
    };
    process.on("uncaughtException", onFatal);
    process.on("unhandledRejection", onFatal);
    root.render(
      <App
        workspace={createTuiWorkspace(client)}
        controller={controller}
        tui={tui}
        clipboard={clipboard}
        onQuit={quit}
        onDown={down}
        onAttached={(next) => {
          controller = next;
        }}
        bootError={bootError}
        bootErrorMissing={bootErrorMissing}
        bootErrorConfig={bootErrorConfig}
        terminalBackground={terminalBackground}
      />,
    );
  });
}
