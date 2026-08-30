import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { type DevctlConfig } from "../config/index.ts";
import { openLocal, type Controller } from "../controller.ts";
import { humanMessage } from "../errors.ts";
import { App } from "./App.tsx";
import { holdStderrForTui, silenceGcpMetadataWarnings } from "../warnings.ts";
import { loadTuiConfig } from "./tui-config.ts";

export async function runTuiWithController(controller: Controller): Promise<void> {
  const tui = loadTuiConfig(controller.cfg.repoRoot);
  await renderApp(controller, tui);
}

export async function runTui(configPath: string): Promise<void> {
  let controller: Controller | undefined;
  let bootError: string | undefined;
  try {
    controller = await openLocal("", configPath);
  } catch (err) {
    bootError = humanMessage(err);
  }
  const tui = loadTuiConfig(controller?.cfg.repoRoot ?? process.cwd());
  await renderApp(controller, tui, bootError);
}

export async function renderApp(
  controller: Controller | undefined,
  tui = loadTuiConfig(controller?.cfg.repoRoot ?? process.cwd()),
  bootError?: string,
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
  await new Promise<void>((resolve) => {
    const quit = (detach?: boolean): void => {
      const finish = (): void => {
        restoreStderr();
        renderer.destroy();
        resolve();
      };
      if (!controller) {
        finish();
        return;
      }
      void controller.close({ detach }).finally(finish);
    };
    root.render(<App controller={controller} tui={tui} onQuit={quit} bootError={bootError} />);
  });
}

export function tuiConfigFor(cfg: DevctlConfig) {
  return loadTuiConfig(cfg.repoRoot);
}
