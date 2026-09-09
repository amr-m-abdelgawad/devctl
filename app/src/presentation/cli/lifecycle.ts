import { Command } from "commander";
import { setTimeout as delay } from "node:timers/promises";
import { Detector } from "../../shared/redaction.ts";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import type { StatusSnapshot } from "../../domain/status.ts";
import { displayState, formatPlan } from "../../domain/service/services.ts";
import { configFlag, writeOut } from "./shared.ts";

export function addExec(root: Command, runtime: ClientRuntime): void {
  root.command("exec")
    .argument("<service>", "service whose execution context to use")
    .argument("[command...]", "command and arguments")
    .option("--print-env", "print the resolved environment instead of running a command")
    .option("--reveal", "show secret values with --print-env")
    .option("--json", "machine-readable output")
    .action(async (service: string, command: string[], opts: { printEnv?: boolean; reveal?: boolean; json?: boolean }) => {
      if (!opts.printEnv && command.length === 0) throw new Error("exec command is required (or use --print-env)");
      const ctrl = await runtime.openController("", configFlag(root), true);
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

export function addRun(root: Command, runtime: ClientRuntime): void {
  root.command("run").argument("<task>", "task to run").option("--json", "machine-readable output").action(async (task: string, opts: { json?: boolean }) => {
    const ctrl = await runtime.openController("", configFlag(root), true);
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
export function addStart(root: Command, runtime: ClientRuntime): void {
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
      const ctrl = await runtime.openController("", configFlag(root), true);
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

export function addStop(root: Command, runtime: ClientRuntime): void {
  root
    .command("stop")
    .argument("[services...]", "services to stop")
    .option("--json", "machine-readable output")
    .action(async (services: string[], opts: { json?: boolean }) => {
      const ctrl = await runtime.openController("", configFlag(root), true);
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

export function addRestart(root: Command, runtime: ClientRuntime): void {
  root
    .command("restart")
    .argument("[services...]")
    .option("--cascade", "also restart transitive dependents (default: only the named services)")
    .option("--json", "machine-readable output")
    .action(async (services: string[], opts: { cascade?: boolean; json?: boolean }) => {
      const ctrl = await runtime.openController("", configFlag(root), true);
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
async function renderStatusOnce(runtime: ClientRuntime, root: Command, opts: { repo?: string; json?: boolean }): Promise<void> {
  // Deliberately not runtime.openController(): status only needs a repo root to
  // dial, not a parsed config, so a deleted .devctl must not prevent it
  // from finding a still-live daemon (findDaemon's discovery-then-
  // state-scan fallback handles that).
  const { repoRoot, client } = await runtime.findDaemon("", opts.repo ?? "", configFlag(root));
  try {
    if (!client) {
      const persisted = runtime.readPersistedState(repoRoot);
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
    runtime.assertMethodAllowed(client, "status");
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

export function addStatus(root: Command, runtime: ClientRuntime): void {
  root
    .command("status")
    .option("--repo <path>", "target a repository directly, even without a loadable configuration")
    .option("--json", "machine-readable output")
    .option("--watch", "keep refreshing until interrupted")
    .action(async (opts: { repo?: string; json?: boolean; watch?: boolean }) => {
      if (!opts.watch) {
        await renderStatusOnce(runtime, root, opts);
        return;
      }
      const abort = new AbortController();
      const onSignal = (): void => abort.abort();
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        while (!abort.signal.aborted) {
          writeOut(`--- ${new Date().toISOString()} ---\n`);
          await renderStatusOnce(runtime, root, opts);
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

export function addDown(root: Command, runtime: ClientRuntime): void {
  root
    .command("down")
    .description("stop the daemon (and, by default, its services)")
    .option("--repo <path>", "target a repository directly, even without a loadable configuration")
    .option("--keep-services", "stop only the daemon; its services keep running, detached")
    .action(async (opts: { repo?: string; keepServices?: boolean }) => {
      const { repoRoot, client } = await runtime.findDaemon("", opts.repo ?? "", configFlag(root));
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
      await waitUntilUnreachable(runtime, repoRoot, timeout);
      writeOut(
        opts.keepServices !== true
          ? `stopped services and the supervisor for ${repoRoot}\n`
          : `stopped the supervisor for ${repoRoot}; its services keep running\n`,
      );
    });
}

async function waitUntilUnreachable(runtime: ClientRuntime, repoRoot: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await runtime.tryDial(repoRoot);
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
export function addAttach(root: Command, runtime: ClientRuntime): void {
  root.command("attach").action(async () => {
    const ctrl = await runtime.openAttach("", configFlag(root));
    const { runTuiWithController } = await import("../tui/index.tsx");
    await runTuiWithController(runtime, ctrl);
  });
}
