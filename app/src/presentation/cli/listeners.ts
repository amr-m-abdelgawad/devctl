import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { derivedMcpPort } from "../mcp/port.ts";
import { claudeSnippet, cursorSnippet, kiloSnippet, codexToml, formatMcpSnippets, mcpUrl } from "../mcp/snippets.ts";
import { configFlag, writeOut } from "./shared.ts";

export function addProxy(root: Command, runtime: ClientRuntime): void {
  const proxy = root.command("proxy");
  proxy
    .command("status")
    .option("--json")
    .action(async (opts: { json?: boolean }) => {
      const ctrl = await runtime.openController("", configFlag(root), false);
      try {
        if (!ctrl.client) {
          writeOut("PROXY  STOPPED\n");
          return;
        }
        const snap = await ctrl.status();
        if (opts.json) {
          writeOut(JSON.stringify(snap.proxy, null, 2) + "\n");
          return;
        }
        writeOut(`PROXY  ${snap.proxy.running ? "RUNNING" : "STOPPED"}  ${snap.proxy.address ?? ""}\n`);
        for (const r of snap.proxy.routes ?? []) {
          const match = r.match ? `  match=${r.match}` : "";
          const client = r.client_id ? `  client_id=${r.client_id}` : "";
          writeOut(`  ${r.name.padEnd(16)} identity=${r.identity}${match}${client}  ${r.upstream}\n`);
        }
      } finally {
        await ctrl.close();
      }
    });
  proxy.command("start").action(async () => {
    const ctrl = await runtime.openController("", configFlag(root), true);
    try {
      await ctrl.proxyStart();
    } finally {
      await ctrl.close();
    }
  });
  proxy.command("stop").action(async () => {
    const ctrl = await runtime.openController("", configFlag(root), true);
    try {
      await ctrl.proxyStop();
    } finally {
      await ctrl.close();
    }
  });
}

export function addMcp(root: Command, runtime: ClientRuntime): void {
  root
    .command("mcp")
    .description("Local MCP server for coding agents")
    .option("--on", "start the MCP listener")
    .option("--off", "stop the MCP listener")
    .option("--port <port>", "listen port")
    .option("--json", "machine-readable output")
    .action(async (opts: { on?: boolean; off?: boolean; port?: string; json?: boolean }) => {
      const portOpt = opts.port === undefined ? undefined : Number(opts.port);
      if (opts.port !== undefined && (!Number.isInteger(portOpt) || (portOpt ?? 0) <= 0)) {
        throw new Error(`invalid --port ${opts.port}`);
      }
      const ctrl = await runtime.openController("", configFlag(root), opts.on === true, { allowMissingConfig: true });
      try {
        if (opts.off === true && ctrl.client) {
          await ctrl.mcpStop();
        } else if (opts.on === true) {
          await ctrl.mcpStart({ port: portOpt });
        }
        const snap = ctrl.client ? await ctrl.status() : undefined;
        const tui = runtime.loadTuiConfig(ctrl.cfg.repoRoot, ctrl.cfg.ui.keymap);
        const port = snap?.mcp?.port ?? portOpt ?? tui.mcp_port ?? derivedMcpPort(ctrl.cfg.repoRoot);
        const url = snap?.mcp?.address ?? mcpUrl(port);
        const token = snap?.mcp?.token ?? "";
        if (opts.json) {
          writeOut(
            JSON.stringify(
              {
                running: snap?.mcp?.running === true,
                setup_mode: snap?.setup_mode === true,
                url,
                port,
                snippets: {
                  claude: JSON.parse(claudeSnippet(url, token)),
                  cursor: JSON.parse(cursorSnippet(url, token)),
                  kilo: JSON.parse(kiloSnippet(url, token)),
                  codex: codexToml(url, token),
                },
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }
        writeOut(`MCP  ${snap?.mcp?.running ? "RUNNING" : "STOPPED"}  ${url}\n\n`);
        if (snap?.setup_mode === true) {
          writeOut(`This repository has no .devctl yet, so the daemon is in setup mode.\n`);
          writeOut(`Connect an agent with the config below and ask it to set devctl up for this repository.\n`);
          writeOut(`It can call get_setup_guide, search_docs, and validate_config; nothing will run until a configuration exists.\n\n`);
        }
        writeOut(formatMcpSnippets(url, token));
      } finally {
        await ctrl.close();
      }
    });
}
