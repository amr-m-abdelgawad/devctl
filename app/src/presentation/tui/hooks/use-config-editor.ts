import { type TextareaRenderable } from "@opentui/core";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useRef, useState } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../types.ts";
import { type ConfirmKind, type Overlay } from "../types.ts";

type Options = {
  cfg: DevctlConfig | undefined;
  readTextFile: (path: string) => string;
  setOverlay: Dispatch<SetStateAction<Overlay>>;
  setStatus: Dispatch<SetStateAction<string>>;
  validateConfigText: (repoRoot: string, configPath: string, text: string) => string[];
  writeTextFile: (path: string, text: string) => void;
  controller: Controller | undefined;
  setConfirmKind: Dispatch<SetStateAction<ConfirmKind>>;
  refresh: () => Promise<StatusSnapshot | undefined>;
};

export function useConfigEditor({
  cfg,
  readTextFile,
  setOverlay,
  setStatus,
  validateConfigText,
  writeTextFile,
  controller,
  setConfirmKind,
  refresh,
}: Options) {

  const configEditRef = useRef<TextareaRenderable>(null);
  const [configEditText, setConfigEditText] = useState("");
  const [configEditError, setConfigEditError] = useState("");

  const openConfigBuffer = useCallback(() => {
    if (!cfg) {
      return;
    }
    try {
      setConfigEditText(readTextFile(cfg.configPath));
      setConfigEditError("");
      setOverlay("config-edit");
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [cfg]);

  const saveConfigBuffer = useCallback(() => {
    if (!cfg) {
      return;
    }
    const text = configEditRef.current?.plainText ?? configEditText;
    const issues = validateConfigText(cfg.repoRoot, cfg.configPath, text);
    if (issues.length > 0) {
      setConfigEditError(issues.join("\n"));
      setStatus("Config buffer not saved");
      return;
    }
    writeTextFile(cfg.configPath, text);
    setConfigEditError("");
    setOverlay("none");
    if (!controller) {
      setStatus(`Wrote ${cfg.configPath}`);
      return;
    }
    void controller.reload().then((result) => {
      setStatus(result.restart_required.length === 0 ? "Configuration saved and reloaded" : `Saved; restart required: ${result.restart_required.join(", ")}`);
      if (result.restart_required.length > 0) {
        setConfirmKind("reload");
        setOverlay("confirm");
      }
      void refresh();
    });
  }, [cfg, configEditText, controller, refresh]);
  return { configEditRef, configEditText, configEditError, setConfigEditError, openConfigBuffer, saveConfigBuffer };
}
