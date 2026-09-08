import { humanMessage } from "../../shared/errors.ts";
import type { McpHost, McpListener, McpListenerFactory } from "../../ports/mcp-host.ts";
import { loadTuiConfig } from "../config/tui-preferences.ts";
import { resolveMcpPort } from "../net/mcp-port.ts";
import { readOrCreateMcpToken } from "../storage/storage.ts";

export type McpCoordinatorDeps = {
  repoRoot: () => string;
  createListener: McpListenerFactory;
  hostApi: () => McpHost;
  isKnownTool: (name: string) => boolean;
  log: (service: string, level: string, message: string) => void;
  persistState: () => void;
};

export class McpCoordinator {
  private listener?: McpListener;
  private disabled: string[] = [];
  readonly token: string;
  private readonly deps: McpCoordinatorDeps;

  constructor(deps: McpCoordinatorDeps) {
    this.deps = deps;
    this.token = readOrCreateMcpToken(deps.repoRoot());
  }

  get instance(): McpListener | undefined {
    return this.listener;
  }

  get disabledTools(): string[] {
    return this.disabled;
  }

  async bootFromPreferences(): Promise<void> {
    // MCP boot must not depend on which client happens to spawn or first
    // attach to this daemon (CLI vs TUI): read the user's saved preference
    // directly here rather than relying on a client to apply it.
    const prefs = loadTuiConfig(this.deps.repoRoot());
    // Same reasoning as mcp_enabled/mcp_port: the deny-list is a saved user
    // preference, so the daemon applies it itself at boot whether a CLI or
    // TUI client spawned it, rather than waiting for a client to push it.
    this.setDisabledTools(prefs.mcp_disabled_tools ?? []);
    if (prefs.mcp_enabled) {
      await this.start(prefs.mcp_port).catch((err) => this.deps.log("devctl", "ERROR", humanMessage(err)));
    }
  }

  async start(port?: number): Promise<void> {
    if (this.listener?.isRunning()) {
      return;
    }
    const resolved = await resolveMcpPort(this.deps.repoRoot(), port);
    this.listener = this.deps.createListener({
      port: resolved,
      token: this.token,
      hostApi: this.deps.hostApi(),
      onEvent: (level, message) => this.deps.log("mcp", level, `mcp ${message}`),
      disabledTools: () => this.disabled,
    });
    await this.listener.start();
    this.deps.persistState();
  }

  // Unknown names are dropped rather than stored: a stale name from an older
  // version would otherwise sit in the list forever, disabling nothing and
  // showing up in status as a tool that does not exist.
  setDisabledTools(names: readonly string[]): void {
    const known = names.filter((name) => this.deps.isKnownTool(name));
    const before = this.disabled.join(",");
    this.disabled = [...new Set(known)].sort();
    // Only when it actually changes, and never the boring "nothing is
    // disabled" case at boot: this runs on every daemon start, and an
    // unconditional line here is pure noise in every session's log.
    if (this.disabled.join(",") === before) {
      return;
    }
    this.deps.log("devctl", "INFO", this.disabled.length === 0
      ? "all MCP tools enabled"
      : `MCP tools disabled: ${this.disabled.join(", ")}`);
  }

  async stop(): Promise<void> {
    await this.listener?.stop();
    this.listener = undefined;
    this.deps.persistState();
  }
}
