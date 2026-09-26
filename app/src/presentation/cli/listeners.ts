import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { derivedMcpPort } from "../mcp/port.ts";
import { join } from "node:path";
import {
  claudeSnippet,
  codexToml,
  cursorSnippet,
  formatMcpSnippets,
  isWritableSnippet,
  kiloSnippet,
  mcpUrl,
  mergeSnippetFile,
  snippetPath,
  WRITABLE_SNIPPETS,
  type WritableSnippetKind,
} from "../mcp/snippets.ts";
import { MCP_TOKEN_TTL_DAYS, formatMcpTokenAge } from "../../shared/mcp-token.ts";
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
    .option("--rotate", "mint a new bearer token (restarts the listener if it is running)")
    .option("--write <client>", `write this stack's MCP config for ${WRITABLE_SNIPPETS.join(", ")} into the checkout`)
    .option("--json", "machine-readable output")
    .action(async (opts: { on?: boolean; off?: boolean; port?: string; rotate?: boolean; write?: string; json?: boolean }) => {
      const portOpt = opts.port === undefined ? undefined : Number(opts.port);
      if (opts.port !== undefined && (!Number.isInteger(portOpt) || (portOpt ?? 0) <= 0)) {
        throw new Error(`invalid --port ${opts.port}`);
      }
      if (opts.write !== undefined && !isWritableSnippet(opts.write)) {
        throw new Error(
          opts.write === "codex"
            ? "codex reads ~/.codex/config.toml, not a per-checkout file; use the snippet `devctl mcp` prints (or `codex mcp add`)"
            : `--write takes one of ${WRITABLE_SNIPPETS.join(", ")}`,
        );
      }
      const ctrl = await runtime.openController("", configFlag(root), opts.on === true, { allowMissingConfig: true });
      try {
        let rotatedToken = "";
        if (opts.rotate === true) {
          if (ctrl.client) {
            await ctrl.mcpRotate();
          } else {
            rotatedToken = runtime.rotateMcpToken(ctrl.cfg.repoRoot);
          }
        }
        if (opts.off === true && ctrl.client) {
          await ctrl.mcpStop();
        } else if (opts.on === true) {
          await ctrl.mcpStart({ port: portOpt });
        }
        const snap = ctrl.client ? await ctrl.status() : undefined;
        const tui = runtime.loadTuiConfig(ctrl.cfg.repoRoot, ctrl.cfg.ui.keymap);
        const port = snap?.mcp?.port ?? portOpt ?? tui.mcp_port ?? derivedMcpPort(ctrl.cfg.repoRoot, ctrl.cfg.instance.name);
        const url = snap?.mcp?.address ?? mcpUrl(port);
        const token = snap?.mcp?.token ?? rotatedToken;
        const ageMs = snap?.mcp?.token_age_ms ?? runtime.mcpTokenAgeMs(ctrl.cfg.repoRoot);
        if (opts.write !== undefined && isWritableSnippet(opts.write)) {
          writeSnippetFile(runtime, ctrl.cfg.repoRoot, opts.write, url, token);
          return;
        }
        if (opts.json) {
          writeOut(
            JSON.stringify(
              {
                running: snap?.mcp?.running === true,
                setup_mode: snap?.setup_mode === true,
                url,
                port,
                token_age_ms: ageMs,
                token_ttl_days: MCP_TOKEN_TTL_DAYS,
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
        writeOut(`MCP  ${snap?.mcp?.running ? "RUNNING" : "STOPPED"}  ${url}\n`);
        if (ageMs !== undefined) {
          writeOut(`token age ${formatMcpTokenAge(ageMs)} (TTL ${MCP_TOKEN_TTL_DAYS}d; rotate with devctl mcp --rotate)\n`);
        }
        writeOut(`\n`);
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

// Parallel stacks (#117): each worktree's agent reads its own project config,
// so writing the stack's URL and token there points it at its own stack.
function writeSnippetFile(runtime: ClientRuntime, repoRoot: string, kind: WritableSnippetKind, url: string, token: string): void {
  if (token === "") {
    throw new Error("the MCP listener isn't running, so there is no token to write; start it with `devctl mcp --on --write " + kind + "`");
  }
  const rel = snippetPath(kind);
  const path = join(repoRoot, rel);
  const existing = runtime.fileExists(path) ? runtime.readTextFile(path) : undefined;
  runtime.writeSecretFile(path, mergeSnippetFile(kind, existing, url, token));
  writeOut(`wrote ${rel}: devctl -> ${url}\n`);
  writeOut(`It holds this stack's bearer token: keep it out of git, and write it again after \`devctl mcp --rotate\`.\n`);
}
