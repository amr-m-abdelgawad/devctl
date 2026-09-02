import { Command } from "commander";
import { stringify } from "yaml";
import { defaultConfig, load, stopOnExit, validate } from "./config/index.ts";
import { assertMethodAllowed, findDaemon, openAttach, openController, tryDial } from "./controller.ts";
import { readPersistedState } from "./storage.ts";
import type { StatusSnapshot } from "./types.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { ExitSuccess, humanMessage, exitCode } from "./errors.ts";
import { detectGoogle, loginGoogle, logoutGoogle } from "./google.ts";
import { refreshThreshold } from "./config/index.ts";
import { TokenManager, googleTokenProviders } from "./token.ts";
import { displayState } from "./services.ts";
import { runSetup } from "./setup.ts";
import { formatPlan, Supervisor } from "./supervisor.ts";
import { derivedMcpPort } from "./mcp/port.ts";
import { claudeSnippet, cursorSnippet, kiloSnippet, codexToml, formatMcpSnippets, mcpUrl } from "./mcp/snippets.ts";
import { loadTuiConfig } from "./tui/tui-config.ts";
import { runTui } from "./tui/index.tsx";
import { completeLine, completionScript } from "./complete.ts";
import { checkUpdate } from "./update.ts";
import { versionLine } from "./version.ts";

export function newRoot(): Command {
  const root = new Command();
  root
    .name("devctl")
    .description("Local development orchestrator")
    .version(versionLine(), "-V, --version", "print version")
    .option("--config <path>", "path to config file or .devctl directory");
  root.command("version").description("print version").action(() => {
    writeOut(`${versionLine()}\n`);
  });
  root.action(async () => {
    const opts = root.opts<{ config?: string }>();
    await runTui(opts.config ?? "");
  });
  addStart(root);
  addStop(root);
  addRestart(root);
  addStatus(root);
  addDown(root);
  addLogs(root);
  addDoctor(root);
  addSetup(root);
  addAuth(root);
  addProxy(root);
  addMcp(root);
  addConfig(root);
  addReload(root);
  addAttach(root);
  addCompletion(root);
  addUpdate(root);
  addSupervisor(root);
  return root;
}

function configFlag(cmd: Command): string {
  const opts = cmd.optsWithGlobals() as { config?: string };
  return opts.config ?? "";
}

function addStart(root: Command): void {
  root
    .command("start")
    .argument("[services...]", "services to start")
    .option("--profile <name>", "profile to start")
    .option("--detach", "leave supervisor running after the command exits")
    .option("--json", "machine-readable output")
    .action(async (services: string[], opts: { profile?: string; detach?: boolean; json?: boolean }) => {
      const ctrl = await openController("", configFlag(root), true);
      try {
        const plan = await ctrl.start({ services, profile: opts.profile, detach: opts.detach === true });
        if (opts.json) {
          writeOut(JSON.stringify(plan, null, 2) + "\n");
          return;
        }
        writeOut(formatPlan(plan));
        if (opts.detach) {
          writeOut("detached; services continue running\n");
        }
      } finally {
        await ctrl.close();
      }
    });
}

function addStop(root: Command): void {
  root
    .command("stop")
    .argument("[services...]", "services to stop")
    .option("--json", "machine-readable output")
    .action(async (services: string[], opts: { json?: boolean }) => {
      const ctrl = await openController("", configFlag(root), true);
      try {
        await ctrl.stop(services);
        if (opts.json) {
          writeOut(JSON.stringify({ stopped: services }, null, 2) + "\n");
        }
      } finally {
        await ctrl.close();
      }
    });
}

function addRestart(root: Command): void {
  root
    .command("restart")
    .argument("[services...]")
    .option("--json", "machine-readable output")
    .action(async (services: string[], opts: { json?: boolean }) => {
      const ctrl = await openController("", configFlag(root), true);
      try {
        await ctrl.restart(services);
        if (opts.json) {
          writeOut(JSON.stringify({ restarted: services }, null, 2) + "\n");
        }
      } finally {
        await ctrl.close();
      }
    });
}

function addStatus(root: Command): void {
  root
    .command("status")
    .option("--repo <path>", "target a repository directly, even without a loadable configuration")
    .option("--json", "machine-readable output")
    .action(async (opts: { repo?: string; json?: boolean }) => {
      // Deliberately not openController(): status only needs a repo root to
      // dial, not a parsed config, so a deleted .devctl must not prevent it
      // from finding a still-live daemon (findDaemon's discovery-then-
      // state-scan fallback handles that).
      const { repoRoot, client } = await findDaemon("", opts.repo ?? "");
      try {
        if (!client) {
          const persisted = readPersistedState(repoRoot);
          if (opts.json) {
            writeOut(JSON.stringify({ running: false, persisted }, null, 2) + "\n");
            return;
          }
          writeOut("supervisor is not running\n");
          if (persisted && persisted.processes.length > 0) {
            writeOut(`last session ${persisted.session_id}  profile ${persisted.profile || "(none)"}\n`);
            for (const proc of persisted.processes) {
              writeOut(`${proc.name}\tstopped\tUNKNOWN\t${proc.pid}\n`);
            }
          }
          return;
        }
        assertMethodAllowed(client, "status");
        const snap = (await client.call("status", null)) as StatusSnapshot;
        if (opts.json) {
          writeOut(JSON.stringify(snap, null, 2) + "\n");
          return;
        }
        writeOut(`PROFILE: ${snap.profile || "(none)"}\n\nSERVICE\tSTATUS\tHEALTH\tPID\n`);
        for (const [name, rt] of Object.entries(snap.services)) {
          writeOut(`${name}\t${displayState(rt)}\t${rt.health}\t${rt.pid}\n`);
        }
        writeOut(`\nPROXY       ${snap.proxy.running ? "RUNNING" : "STOPPED"}     ${snap.proxy.address ?? ""}\n`);
        writeOut(`MCP         ${snap.mcp?.running ? "RUNNING" : "STOPPED"}     ${snap.mcp?.address ?? ""}\n`);
        writeOut(`IDENTITY    ${snap.identity.user || "(unknown)"}\n`);
        writeOut(`CLOUD       ${snap.identity.project || "(unset)"}\n`);
      } finally {
        client?.close();
      }
    });
}

function addDown(root: Command): void {
  root
    .command("down")
    .description("stop the daemon (and, by default, its services)")
    .option("--repo <path>", "target a repository directly, even without a loadable configuration")
    .option("--keep-services", "stop only the daemon; its services keep running, detached")
    .action(async (opts: { repo?: string; keepServices?: boolean }) => {
      const { repoRoot, client } = await findDaemon("", opts.repo ?? "");
      if (!client) {
        writeOut(`no supervisor is running for ${repoRoot}\n`);
        return;
      }
      const timeout = await shutdownTimeoutFor(client);
      try {
        const stopServices = opts.keepServices !== true;
        // shutdown must work even against an incompatible daemon — it's
        // the one command that removes it — so this deliberately skips
        // assertMethodAllowed.
        await client.call("shutdown", { stop_services: stopServices }, timeout);
      } finally {
        client.close();
      }
      // The RPC response above only means the daemon *accepted* the
      // request — dispatch("shutdown") replies immediately and does the
      // actual work shortly after (so the reply can flush before its own
      // socket goes away). down's job is to leave the daemon actually
      // gone, so wait for it to stop answering before reporting success.
      await waitUntilUnreachable(repoRoot, timeout);
      writeOut(
        opts.keepServices !== true
          ? `stopped services and the supervisor for ${repoRoot}\n`
          : `stopped the supervisor for ${repoRoot}; its services keep running\n`,
      );
    });
}

async function waitUntilUnreachable(repoRoot: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await tryDial(repoRoot);
    if (!probe) {
      return;
    }
    probe.close();
  }
}

// down works even without a loadable local config, so it can't rely on
// cfg.shutdown.grace_seconds the way Controller.close() does. The daemon's
// own last-known-good config (available even after .devctl is deleted) is
// the more accurate source when it's reachable; fall back to a generous
// fixed timeout otherwise — the shutdown itself still completes
// server-side even if this client stops waiting for the response.
async function shutdownTimeoutFor(client: { call: (method: string, params: unknown) => Promise<unknown> }): Promise<number> {
  const fallback = 30_000;
  try {
    const cfg = (await client.call("config_snapshot", null)) as { shutdown?: { grace_seconds?: number } };
    const grace = typeof cfg.shutdown?.grace_seconds === "number" ? cfg.shutdown.grace_seconds : 0;
    return Math.max(5_000, grace * 1_000 + 2_000);
  } catch {
    return fallback;
  }
}

function addLogs(root: Command): void {
  const logs = root.command("logs").argument("[services...]");
  logs
    .option("--level <level>", "minimum level")
    .option("--search <text>", "substring or regex search")
    .option("--regex", "treat search as regular expression")
    .option("--source <source>", "filter by source")
    .option("--since <timestamp>", "only events at or after this ISO timestamp")
    .option("--until <timestamp>", "only events at or before this ISO timestamp")
    .option("--output <path>", "export path")
    .option("--json", "machine-readable output")
    .action(async (services: string[], opts: { level?: string; search?: string; regex?: boolean; source?: string; since?: string; until?: string; output?: string; json?: boolean }) => {
      const ctrl = await openController("", configFlag(root), true);
      try {
        const events = await ctrl.logs({
          services,
          level: opts.level,
          search: opts.search,
          regex: opts.regex,
          source: opts.source,
          since: opts.since,
          until: opts.until,
          export: opts.output,
        });
        if (opts.output) {
          writeOut(`exported ${opts.output}\n`);
          return;
        }
        if (opts.json) {
          writeOut(JSON.stringify(events, null, 2) + "\n");
          return;
        }
        for (const ev of events) {
          writeOut(`${ev.timestamp.slice(11, 19)} ${ev.service.padEnd(10)} ${String(ev.level).padEnd(6)} ${ev.message}\n`);
        }
      } finally {
        await ctrl.close();
      }
    });
  logs
    .command("export")
    .argument("[services...]")
    .requiredOption("--output <path>", "export path")
    .option("--level <level>", "minimum level")
    .option("--search <text>", "substring or regex search")
    .option("--regex", "treat search as regular expression")
    .option("--source <source>", "filter by source")
    .action(async (services: string[], opts: { output: string; level?: string; search?: string; regex?: boolean; source?: string }) => {
      const ctrl = await openController("", configFlag(root), true);
      try {
        await ctrl.logs({
          services,
          level: opts.level,
          search: opts.search,
          regex: opts.regex,
          source: opts.source,
          export: opts.output,
        });
        writeOut(`exported ${opts.output}\n`);
      } finally {
        await ctrl.close();
      }
    });
}

function addDoctor(root: Command): void {
  root
    .command("doctor")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const cfg = load("", configFlag(root));
      const report = await runDoctor(cfg);
      if (opts.json) {
        writeOut(JSON.stringify(report, null, 2) + "\n");
      } else {
        writeOut(formatDoctor(report));
      }
      if (report.issues > 0) {
        process.exitCode = 2;
      }
    });
}

function addSetup(root: Command): void {
  root
    .command("setup")
    .option("--force", "overwrite an existing configuration")
    .action(async (opts: { force?: boolean }) => {
      await runSetup("", configFlag(root), opts.force === true);
    });
}

function addAuth(root: Command): void {
  const auth = root.command("auth").description("Google authentication");
  auth
    .command("status")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      let project = "";
      try {
        project = load("", configFlag(root)).google.project_id;
      } catch {
        project = "";
      }
      const st = await detectGoogle(project);
      if (opts.json) {
        writeOut(JSON.stringify(st, null, 2) + "\n");
        return;
      }
      writeOut(`User:      ${st.userEmail || "(unknown)"}\n`);
      writeOut(`Project:   ${st.projectID || "(unset)"}\n`);
      if (st.projectID !== "") {
        writeOut(`Source:    ${st.projectSource}\n`);
      }
      writeOut(`ADC:       ${st.adcAvailable}\n`);
      writeOut(`gcloud:    ${st.gcloudInstalled}\n`);
    });
  auth.command("login").action(async () => {
    await loginGoogle();
  });
  auth.command("logout").action(async () => {
    await logoutGoogle();
  });
  auth
    .command("refresh")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const cfg = load("", configFlag(root));
      const tokens = new TokenManager(refreshThreshold(cfg.auth) * 1000, googleTokenProviders());
      tokens.invalidate();
      const tok = await tokens.get("user", "", []);
      if (opts.json) {
        writeOut(JSON.stringify({ identity: tok.identity, expires_at: tok.expiresAt.toISOString() }, null, 2) + "\n");
        return;
      }
      writeOut(`refreshed credentials expire ${tok.expiresAt.toISOString()}\n`);
    });
}

function addReload(root: Command): void {
  root.command("reload").description("reload configuration").action(async () => {
    const ctrl = await openController("", configFlag(root), true);
    try {
      const result = await ctrl.reload();
      if (result.restart_required.length === 0) {
        writeOut("configuration reloaded\n");
      } else {
        writeOut(`configuration reloaded; restart required: ${result.restart_required.join(", ")}\n`);
      }
      if (result.supervisor_restart_required && result.supervisor_restart_required.length > 0) {
        writeOut(
          `note: ${result.supervisor_restart_required.join(", ")} changed and only take effect after \`devctl stop && devctl start\`\n`,
        );
      }
    } finally {
      await ctrl.close();
    }
  });
}

function addProxy(root: Command): void {
  const proxy = root.command("proxy");
  proxy
    .command("status")
    .option("--json")
    .action(async (opts: { json?: boolean }) => {
      const ctrl = await openController("", configFlag(root), false);
      try {
        if (!ctrl.client && !ctrl.local) {
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
          writeOut(`  ${r.name.padEnd(16)} identity=${r.identity}  ${r.upstream}\n`);
        }
      } finally {
        await ctrl.close();
      }
    });
  proxy.command("start").action(async () => {
    const ctrl = await openController("", configFlag(root), true);
    try {
      await ctrl.proxyStart();
    } finally {
      await ctrl.close();
    }
  });
  proxy.command("stop").action(async () => {
    const ctrl = await openController("", configFlag(root), true);
    try {
      await ctrl.proxyStop();
    } finally {
      await ctrl.close();
    }
  });
}

function addMcp(root: Command): void {
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
      const ctrl = await openController("", configFlag(root), opts.on === true);
      try {
        if (opts.off === true && (ctrl.client || ctrl.local)) {
          await ctrl.mcpStop();
        } else if (opts.on === true) {
          await ctrl.mcpStart({ port: portOpt });
        }
        const snap = ctrl.client || ctrl.local ? await ctrl.status() : undefined;
        const tui = loadTuiConfig(ctrl.cfg.repoRoot);
        const port = snap?.mcp?.port ?? portOpt ?? tui.mcp_port ?? derivedMcpPort(ctrl.cfg.repoRoot);
        const url = snap?.mcp?.address ?? mcpUrl(port);
        const token = snap?.mcp?.token ?? "";
        if (opts.json) {
          writeOut(
            JSON.stringify(
              {
                running: snap?.mcp?.running === true,
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
        writeOut(formatMcpSnippets(url, token));
      } finally {
        await ctrl.close();
      }
    });
}

function addConfig(root: Command): void {
  const cfg = root.command("config");
  cfg
    .command("validate")
    .option("--json")
    .action((opts: { json?: boolean }) => {
      try {
        const loaded = load("", configFlag(root));
        const issues = validate(loaded);
        if (opts.json) {
          writeOut(JSON.stringify({ valid: issues.length === 0, issues }, null, 2) + "\n");
          return;
        }
        if (issues.length > 0) {
          throw new Error(issues.join("\n"));
        }
        writeOut("configuration is valid\n");
      } catch (err) {
        if (opts.json) {
          writeOut(JSON.stringify({ valid: false, error: humanMessage(err) }, null, 2) + "\n");
          return;
        }
        throw err;
      }
    });
  cfg
    .command("show")
    .option("--json")
    .action((opts: { json?: boolean }) => {
      const loaded = load("", configFlag(root));
      if (opts.json) {
        writeOut(JSON.stringify(loaded, null, 2) + "\n");
        return;
      }
      writeOut(stringify(loaded));
    });
}

function addCompletion(root: Command): void {
  root
    .command("completion")
    .argument("[shell]", "zsh, bash, or fish")
    .description("print a shell completion script")
    .action((shell: string | undefined) => {
      writeOut(completionScript(shell || "zsh"));
    });
  root
    .command("__complete", { hidden: true })
    .argument("[line...]")
    .description("internal completion helper")
    .action((words: string[]) => {
      const line = words.join(" ");
      const prefix = line === "" ? "devctl " : line;
      try {
        const cfg = load("", configFlag(root));
        writeOut(completeLine(prefix, cfg).join("\n") + "\n");
      } catch {
        writeOut(completeLine(prefix, defaultConfig()).join("\n") + "\n");
      }
    });
}

function addUpdate(root: Command): void {
  root
    .command("update")
    .description("check GitHub Releases for a newer version")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const result = await checkUpdate();
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      writeOut(`current  ${result.current}\n`);
      writeOut(`latest   ${result.latest || "(unavailable)"}\n`);
      if (result.newer) {
        writeOut(`install  ${result.hint}\n`);
      } else if (result.latest !== "") {
        writeOut("up to date\n");
      }
    });
}

function addAttach(root: Command): void {
  root.command("attach").action(async () => {
    const ctrl = await openAttach("", configFlag(root));
    const { runTuiWithController } = await import("./tui/index.tsx");
    await runTuiWithController(ctrl);
  });
}

function addSupervisor(root: Command): void {
  root
    .command("_supervisor")
    .option("--repo <path>", "repository root")
    .action(async (opts: { repo?: string }) => {
      const cfg = load(opts.repo ?? "", configFlag(root));
      const sup = new Supervisor(cfg);
      // This daemon normally stops via the "shutdown" RPC (`devctl stop`),
      // but it can also receive a signal directly (system shutdown, an
      // admin `kill`, a container orchestrator). Without a handler, Node's
      // default action skips shutdown() entirely — including flushing the
      // now-asynchronous log writes — so register one as a safety net.
      let shuttingDown = false;
      const onSignal = (): void => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        void sup.shutdown(stopOnExit(cfg.shutdown)).finally(() => process.exit(0));
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      await sup.run();
    });
}

export async function execute(): Promise<void> {
  try {
    await newRoot().parseAsync(process.argv);
  } catch (err) {
    process.stderr.write(humanMessage(err) + "\n");
    process.exit(exitCode(err));
  }
}

function writeOut(text: string): void {
  process.stdout.write(text);
}

export { ExitSuccess };
