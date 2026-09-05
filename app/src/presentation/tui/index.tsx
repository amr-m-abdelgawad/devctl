import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { type DevctlConfig } from "../../adapters/config/index.ts";
import { openTui, type Controller } from "../../adapters/rpc/controller.ts";
import { humanMessage, isKind, KindConfigurationMissing } from "../../shared/errors.ts";
import { App } from "./App.tsx";
import { holdStderrForTui, silenceGcpMetadataWarnings } from "../../warnings.ts";
import { loadTuiConfig } from "./tui-config.ts";

export async function runTuiWithController(controller: Controller): Promise<void> {
  const tui = loadTuiConfig(controller.cfg.repoRoot, controller.cfg.ui.keymap);
  await renderApp(controller, tui);
}

export async function runTui(configPath: string): Promise<void> {
  let controller: Controller | undefined;
  let bootError: string | undefined;
  let bootErrorMissing = false;
  try {
    controller = await openTui("", configPath);
  } catch (err) {
    bootError = humanMessage(err);
    bootErrorMissing = isKind(err, KindConfigurationMissing);
  }
  const tui = loadTuiConfig(controller?.cfg.repoRoot ?? process.cwd(), controller?.cfg.ui.keymap);
  await renderApp(controller, tui, bootError, bootErrorMissing);
}

export async function renderApp(
  controller: Controller | undefined,
  tui = loadTuiConfig(controller?.cfg.repoRoot ?? process.cwd(), controller?.cfg.ui.keymap),
  bootError?: string,
  bootErrorMissing = false,
): Promise<void> {
  silenceGcpMetadataWarnings();
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
    const quit = (detach?: boolean): void => {
      const finish = (): void => {
        root.unmount();
        restoreStderr();
        renderer.destroy();
        resolve();
        // The renderer/stdin listening keeps the event loop alive on its
        // own, so it never drains after unmount. controller.close() has
        // already finished all async cleanup by this point, so exiting
        // explicitly is safe and is what actually returns control to the
        // terminal.
        process.exit(0);
      };
      if (!controller) {
        finish();
        return;
      }
      void controller.close({ detach, shutdownSupervisor: true }).finally(finish);
    };
    root.render(
      <App
        controller={controller}
        tui={tui}
        onQuit={quit}
        bootError={bootError}
        bootErrorMissing={bootErrorMissing}
        terminalBackground={terminalBackground}
      />,
    );
  });
}

export function tuiConfigFor(cfg: DevctlConfig) {
  return loadTuiConfig(cfg.repoRoot, cfg.ui.keymap);
}
