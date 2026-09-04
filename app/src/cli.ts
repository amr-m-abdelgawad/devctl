import { Command } from "commander";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import { configDiff, defaultConfig, discover, load, loadOrEmpty, stopOnExit, validate } from "./config/index.ts";
import { assertMethodAllowed, findDaemon, openAttach, openController, tryDial } from "./controller.ts";
import { existsSync, readFileSync } from "node:fs";
import { bootstrapLogPath, readPersistedState } from "./storage.ts";
import type { StatusSnapshot } from "./types.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { ExitSuccess, humanMessage, exitCode } from "./errors.ts";
import { detectGoogle, loginGoogle, logoutGoogle } from "./google.ts";
import { refreshThreshold } from "./config/index.ts";
import { TokenManager, googleTokenProviders } from "./token.ts";
import { displayState, supervisorRestartAdvice } from "./services.ts";
import { runSetup } from "./setup.ts";
import { formatPlan, Supervisor } from "./supervisor.ts";
import { resolveExportPath, type LogEvent, type LogPage } from "./logs.ts";
import { derivedMcpPort } from "./mcp/port.ts";
import { claudeSnippet, cursorSnippet, kiloSnippet, codexToml, formatMcpSnippets, mcpUrl } from "./mcp/snippets.ts";
import { loadTuiConfig } from "./tui/tui-config.ts";
import { runTui } from "./tui/index.tsx";
import { completeLine, completionScript } from "./complete.ts";
import { checkUpdate } from "./update.ts";
import { versionLine } from "./version.ts";
import { Detector } from "./secrets.ts";

export function newRoot(): Command {
  const root = new Command();
  root
    .name("devctl")
    .description("Local development orchestrator")
    .version(versionLine(), "-V, --version", "print version")
    .option("--config <path>", "path to config file or .devctl directory")
    // Global options (--config) must precede the subcommand so that a
    // subcommand can reuse an option name of its own — like logs export's
    // --output, distinct from plain logs' own optional --output — without
    // this level's parser greedily consuming it first. Every subcommand
    // group with its own subcommands (logs -> export) needs this set too;
    // it does not propagate down the tree on its own.
    .enablePositionalOptions();
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
  addRun(root);
  addExec(root);
  addStatus(root);
  addDown(root);
  addLogs(root);
  addDaemon(root);
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

function addExec(root: Command): void {
  root.command("exec")
    .argument("<service>", "service whose execution context to use")
    .argument("[command...]", "command and arguments")
    .option("--print-env", "print the resolved environment instead of running a command")
    .option("--reveal", "show secret values with --print-env")
    .option("--json", "machine-readable output")
    .action(async (service: string, command: string[], opts: { printEnv?: boolean; reveal?: boolean; json?: boolean }) => {
      if (!opts.printEnv && command.length === 0) throw new Error("exec command is required (or use --print-env)");
      const ctrl = await openController("", configFlag(root), true);
      try {
        const result = await ctrl.execService(service, command, opts.printEnv === true);
        if (result.environment) {
          const env = opts.reveal ? result.environment : new Detector(ctrl.cfg.secrets.extra_markers, ctrl.cfg.secrets.extra_patterns).redactMap(result.environment);
          if (opts.json) writeOut(JSON.stringify({ ...result, environment: env }, null, 2) + "\n");
          else for (const key of Object.keys(env).sort()) writeOut(`${key}=${env[key]}\n`);
        } else if (opts.json) writeOut(JSON.stringify(result, null, 2) + "\n");
        else {
          if (result.stdout) writeOut(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
        }
      } finally {
        await ctrl.close();
      }
    });
}

function addRun(root: Command): void {
  root.command("run").argument("<task>", "task to run").option("--json", "machine-readable output").action(async (task: string, opts: { json?: boolean }) => {
    const ctrl = await openController("", configFlag(root), true);
    try {
      const result = await ctrl.runTask(task);
      if (opts.json) writeOut(JSON.stringify(result, null, 2) + "\n");
      else {
        if (result.stdout) writeOut(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
    } finally {
      await ctrl.close();
    }
  });
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
    .option("--detach", "deprecated, no longer changes behavior: the daemon already outlives this command; use `devctl down` to stop it")
    .option("--json", "machine-readable output")
    .action(async (services: string[], opts: { profile?: string; detach?: boolean; json?: boolean }) => {
      if (opts.detach) {
        process.stderr.write(
          "warning: --detach is deprecated and no longer changes behavior — the daemon already keeps running after `start` exits; use `devctl down` to stop it\n",
        );
      }
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
    .option("--cascade", "also restart transitive dependents (default: only the named services)")
    .option("--json", "machine-readable output")
    .action(async (services: string[], opts: { cascade?: boolean; json?: boolean }) => {
      const ctrl = await openController("", configFlag(root), true);
      try {
        await ctrl.restart(services, opts.cascade === true);
        if (opts.json) {
          writeOut(JSON.stringify({ restarted: services, cascade: opts.cascade === true }, null, 2) + "\n");
        }
      } finally {
        await ctrl.close();
      }
    });
}

async function renderStatusOnce(root: Command, opts: { repo?: string; json?: boolean }): Promise<void> {
  // Deliberately not openController(): status only needs a repo root to
  // dial, not a parsed config, so a deleted .devctl must not prevent it
  // from finding a still-live daemon (findDaemon's discovery-then-
  // state-scan fallback handles that).
  const { repoRoot, client } = await findDaemon("", opts.repo ?? "", configFlag(root));
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
}

const WATCH_POLL_MS = 2000;

function addStatus(root: Command): void {
  root
    .command("status")
    .option("--repo <path>", "target a repository directly, even without a loadable configuration")
    .option("--json", "machine-readable output")
    .option("--watch", "keep refreshing until interrupted")
    .action(async (opts: { repo?: string; json?: boolean; watch?: boolean }) => {
      if (!opts.watch) {
        await renderStatusOnce(root, opts);
        return;
      }
      const abort = new AbortController();
      const onSignal = (): void => abort.abort();
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        while (!abort.signal.aborted) {
          writeOut(`--- ${new Date().toISOString()} ---\n`);
          await renderStatusOnce(root, opts);
          writeOut("\n");
          try {
            await delay(WATCH_POLL_MS, undefined, { signal: abort.signal });
          } catch {
            break;
          }
        }
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
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
      const { repoRoot, client } = await findDaemon("", opts.repo ?? "", configFlag(root));
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

function formatLogLineForCli(ev: LogEvent): string {
  return `${ev.timestamp.slice(11, 19)} ${ev.service.padEnd(10)} ${String(ev.level).padEnd(6)} ${ev.message}\n`;
}

// Prints the latest page once, then keeps polling forward from where it
// left off until signal fires. Exported so the loop itself — cursor
// advancing correctly, no duplicate or dropped events across polls, and
// clean termination on abort — is unit-testable without a real daemon.
export async function followLogs(
  fetchPage: (cursor?: string) => Promise<LogPage>,
  onEvent: (ev: LogEvent) => void,
  signal: AbortSignal,
  pollMs = 1000,
): Promise<void> {
  let page = await fetchPage(undefined);
  page.events.forEach(onEvent);
  let cursor = page.nextCursor;
  while (!signal.aborted) {
    try {
      await delay(pollMs, undefined, { signal });
    } catch {
      return;
    }
    page = await fetchPage(cursor);
    page.events.forEach(onEvent);
    cursor = page.nextCursor;
  }
}

function addLogs(root: Command): void {
  // Needed alongside root's own enablePositionalOptions(): logs and its
  // export subcommand both declare --output, and without this, logs' own
  // parser consumes --output before export's turn even begins, leaving
  // export's copy permanently unset.
  const logs = root.command("logs").argument("[services...]").enablePositionalOptions();
  logs
    .option("--level <level>", "minimum level")
    .option("--search <text>", "substring or regex search")
    .option("--regex", "treat search as regular expression")
    .option("--source <source>", "filter by source")
    .option("--since <timestamp>", "only events at or after this ISO timestamp")
    .option("--until <timestamp>", "only events at or before this ISO timestamp")
    .option("--output <path>", "export path")
    .option("--json", "machine-readable output")
    .option("-f, --follow", "keep printing new matching events until interrupted")
    .action(async (services: string[], opts: { level?: string; search?: string; regex?: boolean; source?: string; since?: string; until?: string; output?: string; json?: boolean; follow?: boolean }) => {
      const ctrl = await openController("", configFlag(root), true);
      try {
        // Resolved against this process's own cwd before it crosses the RPC
        // boundary: the daemon may be a long-running background process with
        // an unrelated cwd, so a relative path must not be resolved there.
        const exportPath = opts.output ? resolveExportPath(opts.output) : undefined;
        if (opts.follow && !exportPath) {
          const abort = new AbortController();
          const onSignal = (): void => abort.abort();
          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);
          try {
            await followLogs(
              (cursor) =>
                ctrl.logsPage({
                  services,
                  level: opts.level,
                  search: opts.search,
                  regex: opts.regex,
                  source: opts.source,
                  since: opts.since,
                  until: opts.until,
                  cursor,
                  direction: "forward",
                }),
              (ev) => writeOut(opts.json ? JSON.stringify(ev) + "\n" : formatLogLineForCli(ev)),
              abort.signal,
            );
          } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
          }
          return;
        }
        const events = await ctrl.logs({
          services,
          level: opts.level,
          search: opts.search,
          regex: opts.regex,
          source: opts.source,
          since: opts.since,
          until: opts.until,
          export: exportPath,
        });
        if (exportPath) {
          writeOut(`exported ${exportPath}\n`);
          return;
        }
        if (opts.json) {
          writeOut(JSON.stringify(events, null, 2) + "\n");
          return;
        }
        for (const ev of events) {
          writeOut(formatLogLineForCli(ev));
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
        const exportPath = resolveExportPath(opts.output);
        await ctrl.logs({
          services,
          level: opts.level,
          search: opts.search,
          regex: opts.regex,
          source: opts.source,
          export: exportPath,
        });
        writeOut(`exported ${exportPath}\n`);
      } finally {
        await ctrl.close();
      }
    });
}

// The daemon's own bootstrap stderr (captured by ensureSupervisor() so a
// failed `start`/`attach` has a path to point at) was previously only
// reachable by manually opening that file. discover() only needs to find
// the repo, not load a valid config, since the config is often exactly
// what's broken when this log is worth reading.
function addDaemon(root: Command): void {
  root
    .command("daemon")
    .command("logs")
    .option("-f, --follow", "keep printing new lines until interrupted")
    .action(async (opts: { follow?: boolean }) => {
      const { repoRoot } = discover("", configFlag(root));
      const path = bootstrapLogPath(repoRoot);
      let printed = 0;
      const printNew = (): void => {
        if (!existsSync(path)) {
          return;
        }
        const text = readFileSync(path, "utf8");
        if (text.length > printed) {
          writeOut(text.slice(printed));
          printed = text.length;
        }
      };
      if (!existsSync(path)) {
        writeOut("no daemon bootstrap log yet for this repository\n");
      } else {
        printNew();
      }
      if (!opts.follow) {
        return;
      }
      const abort = new AbortController();
      const onSignal = (): void => abort.abort();
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        while (!abort.signal.aborted) {
          try {
            await delay(500, undefined, { signal: abort.signal });
          } catch {
            break;
          }
          printNew();
        }
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
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
      // Keep the standalone user-token refresh working when no daemon is
      // running, but also ask an attached daemon to re-mint and probe
      // configured service accounts. Previously these were two disconnected
      // paths, so the command printed "refreshed" while the Identity screen
      // remained permanently "NOT PROBED".
      const ctrl = await openController("", configFlag(root), false);
      try {
        const tokens = new TokenManager(refreshThreshold(ctrl.cfg.auth) * 1000, googleTokenProviders());
        // tokens.refresh(), not invalidate()+get() — invalidate() clears
        // every credential in the shared store, not just this one; refresh()
        // forces a fresh mint of only the user identity being checked here.
        const tok = await tokens.refresh("user", "", []);
        const daemonIdentity = ctrl.client ? await ctrl.refreshAuth() : undefined;
        if (opts.json) {
          writeOut(
            JSON.stringify(
              {
                identity: tok.identity,
                expires_at: tok.expiresAt.toISOString(),
                service_account_status: daemonIdentity?.service_account_status ?? {},
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }
        writeOut(`refreshed credentials expire ${tok.expiresAt.toISOString()}\n`);
        if (daemonIdentity) {
          for (const [email, status] of Object.entries(daemonIdentity.service_account_status).sort(([a], [b]) => a.localeCompare(b))) {
            writeOut(`service account ${email}: ${status}\n`);
          }
        }
      } finally {
        await ctrl.close();
      }
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
        writeOut(`note: ${supervisorRestartAdvice(result.supervisor_restart_required)}\n`);
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
      const ctrl = await openController("", configFlag(root), opts.on === true, { allowMissingConfig: true });
      try {
        if (opts.off === true && ctrl.client) {
          await ctrl.mcpStop();
        } else if (opts.on === true) {
          await ctrl.mcpStart({ port: portOpt });
        }
        const snap = ctrl.client ? await ctrl.status() : undefined;
        const tui = loadTuiConfig(ctrl.cfg.repoRoot, ctrl.cfg.ui.keymap);
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
          // The whole point of allowing a config-less daemon: say plainly
          // what state this is and what the next step looks like, so the
          // human knows the empty service list is expected rather than a
          // sign that something failed.
          writeOut(`This repository has no .devctl yet, so the daemon is in setup mode.\n`);
          writeOut(`Connect an agent with the config below and ask it to set devctl up for this repository.\n`);
          writeOut(`It can call get_setup_guide and validate_config; nothing will run until a configuration exists.\n\n`);
        }
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
    .command("diff")
    .description("show where effective configuration values came from")
    .option("--json")
    .action((opts: { json?: boolean }) => {
      const loaded = load("", configFlag(root));
      const entries = configDiff(loaded);
      if (opts.json) {
        writeOut(JSON.stringify({ entries }, null, 2) + "\n");
        return;
      }
      for (const entry of entries) {
        writeOut(`${entry.path} = ${JSON.stringify(entry.value)}\n`);
        writeOut(`  winner: ${entry.layer} (${entry.source})\n`);
        for (const origin of entry.shadowed) writeOut(`  shadowed: ${origin.layer} (${origin.source})\n`);
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
      // loadOrEmpty, not load: a daemon is only ever spawned because a client
      // already decided one should exist, so a missing configuration here means
      // setup mode (see `devctl mcp --on`), not an error worth dying over. An
      // invalid configuration still throws.
      const cfg = loadOrEmpty(opts.repo ?? "", configFlag(root));
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
  // A downstream reader closing early (`devctl status --watch | head -1`, a
  // terminal that goes away mid-stream) makes the next stdout write fail
  // with EPIPE — a normal, quiet end of output, not a crash. This backstops
  // the `error` event a write can emit asynchronously; writeOut() below
  // separately catches the synchronous-throw case.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      process.exit(0);
    }
  });
  try {
    await newRoot().parseAsync(process.argv);
  } catch (err) {
    process.stderr.write(humanMessage(err) + "\n");
    process.exit(exitCode(err));
  }
}

function writeOut(text: string): void {
  try {
    process.stdout.write(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
      process.exit(0);
    }
    throw err;
  }
}

export { ExitSuccess };
