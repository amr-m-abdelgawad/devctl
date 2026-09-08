import type { Dispatch, SetStateAction } from "react";
import { useCallback, useState } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { clampMcpPort, commitMcpPortDraft, derivedMcpPort, isDerivedMcpPort } from "../../mcp/port.ts";
import { mcpSnippets, mcpUrl, type McpSnippet } from "../../mcp/snippets.ts";
import { toolEnabled, type McpToolDef } from "../../mcp/tools.ts";
import { writeClipboard } from "../clipboard.ts";
import { mcpSnippetIndexAtRow } from "../screens/Mcp.tsx";
import { type TuiConfig, type TuiPreferencePatch } from "../tui-config.ts";

type Options = {
  tui: TuiConfig;
  controller: Controller | undefined;
  cfg: DevctlConfig | undefined;
  persistPrefs: (partial: TuiPreferencePatch, message: string) => void;
  snap: StatusSnapshot | undefined;
  refresh: () => Promise<StatusSnapshot | undefined>;
  setStatus: Dispatch<SetStateAction<string>>;
};

export function useMcpControls({
  tui,
  controller,
  cfg,
  persistPrefs,
  snap,
  refresh,
  setStatus,
}: Options) {

  const [mcpPortDraft, setMcpPortDraft] = useState("");
  const [mcpPort, setMcpPort] = useState(() => tui.mcp_port ?? derivedMcpPort(controller?.cfg.repoRoot ?? process.cwd()));

  const persistMcpPort = useCallback(
    (next: number) => {
      const port = clampMcpPort(next);
      setMcpPort(port);
      const root = cfg?.repoRoot ?? process.cwd();
      if (isDerivedMcpPort(root, port)) {
        persistPrefs({ mcp_port: null }, `MCP port ${port} (default)`);
        return;
      }
      persistPrefs({ mcp_port: port }, `MCP port ${port}`);
    },
    [cfg, persistPrefs],
  );

  const applyMcpPortDraft = useCallback(() => {
    if (mcpPortDraft === "") {
      return mcpPort;
    }
    const next = commitMcpPortDraft(mcpPortDraft, mcpPort);
    setMcpPortDraft("");
    persistMcpPort(next);
    return next;
  }, [mcpPort, mcpPortDraft, persistMcpPort]);

  const restartMcpOnPort = useCallback(
    async (port: number) => {
      if (!controller || snap?.mcp?.running !== true) {
        return;
      }
      await controller.mcpStop();
      await controller.mcpStart({ port });
      await refresh();
    },
    [controller, refresh, snap?.mcp?.running],
  );

  // The whole deny-list is sent, not a delta — the daemon is authoritative
  // for what it ends up with (it drops unknown names), and its reply is what
  // gets persisted, so tui.json can never disagree with the running server.
  const toggleMcpTool = useCallback(async (tool: McpToolDef) => {
    if (!controller) {
      setStatus("Supervisor is not running");
      return;
    }
    const current = snap?.mcp?.disabled_tools ?? [];
    const turningOff = toolEnabled(tool.name, current);
    const next = turningOff ? [...current, tool.name] : current.filter((name) => name !== tool.name);
    try {
      const applied = await controller.mcpSetTools(next);
      persistPrefs({ mcp_disabled_tools: applied }, `${tool.label} ${turningOff ? "disabled" : "enabled"}`);
      await refresh();
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [controller, persistPrefs, refresh, snap]);

  const toggleMcp = useCallback(async () => {
    if (!controller) {
      setStatus("Supervisor is not running");
      return;
    }
    try {
      if (snap?.mcp?.running) {
        await controller.mcpStop();
        persistPrefs({ mcp_enabled: false }, "MCP off");
        setStatus("MCP stopped");
      } else {
        await controller.mcpStart({ port: mcpPort });
        persistPrefs({ mcp_enabled: true }, "MCP on");
        setStatus("MCP started");
      }
      await refresh();
    } catch (err) {
      setStatus(humanMessage(err));
    }
  }, [controller, mcpPort, persistPrefs, refresh, snap?.mcp?.running]);

  const copyMcpSnippet = useCallback(
    (snippet: McpSnippet) => {
      void writeClipboard(snippet.text)
        .then(() => {
          setStatus(`Copied ${snippet.title} snippet`);
        })
        .catch((err: unknown) => {
          setStatus(humanMessage(err));
        });
    },
    [],
  );

  const copyFocusedMcpSnippet = useCallback(
    (index: number) => {
      // Snippet rows now sit below the tool list, so their offset depends on
      // how many tools exist — never hardcode it.
      const snippetIndex = mcpSnippetIndexAtRow(index);
      if (snippetIndex === undefined) {
        return false;
      }
      const url = snap?.mcp?.address ?? mcpUrl(snap?.mcp?.port ?? mcpPort);
      const snippet = mcpSnippets(url, snap?.mcp?.token ?? "")[snippetIndex];
      if (!snippet) {
        return false;
      }
      copyMcpSnippet(snippet);
      return true;
    },
    [copyMcpSnippet, mcpPort, snap?.mcp?.address, snap?.mcp?.port, snap?.mcp?.token],
  );

  return {
    mcpPortDraft,
    setMcpPortDraft,
    mcpPort,
    persistMcpPort,
    applyMcpPortDraft,
    restartMcpOnPort,
    toggleMcpTool,
    toggleMcp,
    copyMcpSnippet,
    copyFocusedMcpSnippet,
  };
}
