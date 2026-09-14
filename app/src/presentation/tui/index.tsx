import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ClientRuntime, Controller } from "../../application/client-runtime.ts";
import { createTuiWorkspace } from "./workspace.ts";
import { humanMessage, isKind, KindConfigurationMissing } from "../../shared/errors.ts";
import { App } from "./App.tsx";
import { holdStderrForTui, silenceGcpMetadataWarnings } from "../../shared/warnings.ts";
import { installTerminalRestoreOnExit, restoreTerminalModes } from "../../shared/terminal-restore.ts";

export async function runTuiWithController(client: ClientRuntime, controller: Controller): Promise<void> {
  const tui = client.loadTuiConfig(controller.cfg.repoRoot, controller.cfg.ui.keymap);
  await renderApp(client, controller, tui);
}

export async function runTui(client: ClientRuntime, configPath: string): Promise<void> {
  let controller: Controller | undefined;
  let bootError: string | undefined;
  let bootErrorMissing = false;
  try {
    controller = await client.openTui("", configPath);
  } catch (err) {
    bootError = humanMessage(err);
    bootErrorMissing = isKind(err, KindConfigurationMissing);
  }
  const tui = client.loadTuiConfig(controller?.cfg.repoRoot ?? process.cwd(), controller?.cfg.ui.keymap);
  await renderApp(client, controller, tui, bootError, bootErrorMissing);
}

export async function renderApp(
  client: ClientRuntime,
  controller: Controller | undefined,
  tui = client.loadTuiConfig(controller?.cfg.repoRoot ?? process.cwd(), controller?.cfg.ui.keymap),
  bootError?: string,
  bootErrorMissing = false,
): Promise<void> {
  silenceGcpMetadataWarnings();
  installTerminalRestoreOnExit();
  const restoreStderr = holdStderrForTui();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: tui.mouse,
    enableMouseMovement: tui.mouse,
    useKittyKeyboard: {},
  });
  const root = createRoot(renderer);
  let terminalBackground: string | null = null;
  try {
    terminalBackground = (await renderer.getPalette({ timeout: 120, size: 16 })).defaultBackground;
  } catch {
    // Keep the explicit theme background when the terminal does not answer OSC palette queries.
  }
  await new Promise<void>((resolve) => {
    const leaveTty = (): void => {
      try {
        root.unmount();
        restoreStderr();
        renderer.destroy();
      } finally {
        restoreTerminalModes();
        resolve();
        // The renderer/stdin listening keeps the event loop alive on its
        // own, so it never drains after unmount. controller.close() has
        // already finished all async cleanup by this point, so exiting
        // explicitly is safe and is what actually returns control to the
        // terminal.
        process.exit(0);
      }
    };
    const quit = (detach?: boolean): void => {
      if (!controller) {
        leaveTty();
        return;
      }
      void controller.close({ detach, shutdownSupervisor: true }).finally(leaveTty);
    };
    const down = (keepServices: boolean): void => {
      if (!controller) {
        leaveTty();
        return;
      }
      void controller
        .shutdown({ stopServices: !keepServices })
        .then(() => controller?.close({ detach: true }))
        .finally(leaveTty);
    };
    root.render(
      <App
        workspace={createTuiWorkspace(client)}
        controller={controller}
        tui={tui}
        onQuit={quit}
        onDown={down}
        onAttached={(next) => {
          controller = next;
        }}
        bootError={bootError}
        bootErrorMissing={bootErrorMissing}
        terminalBackground={terminalBackground}
      />,
    );
  });
}
