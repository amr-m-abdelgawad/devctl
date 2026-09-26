import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { ClientRuntime, Controller } from "../../application/client-runtime.ts";
import { configSecretValues, failedTraceIds, maskKnownValues, parseDuration, redactJson, stackEnvironment } from "../../domain/harness.ts";
import { exitCode, humanMessage } from "../../shared/errors.ts";
import { Detector } from "../../shared/redaction.ts";
import { versionLine } from "../../version.ts";
import { shutdownTimeoutFor, waitUntilUnreachable } from "./lifecycle.ts";
import { DEFAULT_WAIT_TIMEOUT, waitForStack } from "./wait.ts";
import { configFlag, writeOut } from "./shared.ts";

// The test/CI harness (#118): `start --wait`, `devctl test` and
// `devctl bundle`.

const BUNDLE_LOG_LIMIT = 5_000;
const BUNDLE_TRACE_LIMIT = 20;
const BUNDLE_TRAFFIC_LIMIT = 200;

export function addTest(root: Command, runtime: ClientRuntime): void {
  root
    .command("test")
    .description("start a throwaway stack, wait until it is healthy, run tests against it, and tear it down")
    .argument("[task-or-command...]", "a task from config, or a command after --")
    .option("--profile <name>", "profile to start")
    .option("--services <names>", "comma-separated services to start, with their dependencies (default: every service, unless --profile)")
    .option("--timeout <duration>", "how long to wait for the stack to be healthy", DEFAULT_WAIT_TIMEOUT)
    .option("--env-from <service>", "run the command with this service's resolved environment, as `devctl exec` does")
    .option("--artifacts <dir>", "where to write the failure bundle", "devctl-artifacts")
    .option("--keep", "leave the stack running afterwards")
    .passThroughOptions()
    .action(async (args: string[], opts: TestOpts) => {
      process.exitCode = await runTest(root, runtime, args, opts);
    });
}

type TestOpts = { profile?: string; services?: string; timeout: string; envFrom?: string; artifacts: string; keep?: boolean };

async function runTest(root: Command, runtime: ClientRuntime, args: string[], opts: TestOpts): Promise<number> {
  if (args.length === 0) {
    throw new Error("devctl test needs a task name or a command after --");
  }
  const timeoutMs = parseDuration(opts.timeout);
  // A throwaway stack of its own (#117): its own slot, ports, state and
  // containers, so it never collides with a dev stack or another CI job.
  // An explicit --instance / DEVCTL_INSTANCE is used as given.
  if (!process.env.DEVCTL_INSTANCE) {
    process.env.DEVCTL_INSTANCE = `test-${randomBytes(3).toString("hex")}`;
  }
  const instance = process.env.DEVCTL_INSTANCE;
  // Ctrl-C reaches the test command too (same process group); keep devctl
  // alive long enough to tear the stack down after it.
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const ctrl = await runtime.openController("", configFlag(root), true);
  const repoRoot = ctrl.cfg.repoRoot;
  let code: number;
  try {
    code = await startAndRun(runtime, ctrl, args, opts, timeoutMs, instance);
    if (interrupted && code === 0) {
      code = 130;
    }
    if (code !== 0) {
      const dir = resolve(opts.artifacts);
      const written = await writeBundle(runtime, ctrl, dir, {});
      process.stderr.write(`devctl: wrote ${written.length} files to ${dir}\n`);
    }
  } finally {
    await teardown(runtime, ctrl, repoRoot, opts.keep === true, instance);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return code;
}

async function startAndRun(runtime: ClientRuntime, ctrl: Controller, args: string[], opts: TestOpts, timeoutMs: number, instance: string): Promise<number> {
  let services = (opts.services ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  // With neither --profile nor --services, a test run gets the whole stack.
  if (services.length === 0 && !opts.profile) {
    services = Object.keys(ctrl.cfg.services);
  }
  try {
    const plan = await ctrl.start({ services, profile: opts.profile });
    await waitForStack(ctrl, ctrl.cfg, plan, timeoutMs);
  } catch (err) {
    process.stderr.write(`devctl: ${humanMessage(err)}\n`);
    return exitCode(err);
  }
  const task = args.length === 1 && args[0] !== undefined && ctrl.cfg.tasks[args[0]] ? args[0] : undefined;
  if (task !== undefined) {
    const result = await ctrl.runTask(task);
    if (result.stdout) writeOut(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, stackEnvironment(await ctrl.status(), instance));
  if (opts.envFrom) {
    const resolved = await ctrl.execService(opts.envFrom, [], true);
    Object.assign(env, resolved.environment ?? {});
  }
  return runtime.runForeground(args, env, process.cwd());
}

async function teardown(runtime: ClientRuntime, ctrl: Controller, repoRoot: string, keep: boolean, instance: string): Promise<void> {
  if (keep) {
    await ctrl.close({ detach: true });
    process.stderr.write(`devctl: left the stack running; stop it with \`devctl --instance ${instance} down\`\n`);
    return;
  }
  const client = ctrl.client;
  const timeout = client ? await shutdownTimeoutFor(client) : 0;
  try {
    await ctrl.shutdown({ stopServices: true });
  } finally {
    await ctrl.close({ detach: true });
  }
  await waitUntilUnreachable(runtime, repoRoot, timeout);
}

export function addBundle(root: Command, runtime: ClientRuntime): void {
  root
    .command("bundle")
    .description("collect status, logs, traces, traffic and config into a redacted bundle for a bug report")
    .option("--since <duration>", "only logs from this long ago (for example 10m)")
    .option("--output <path>", "a directory, or a .tgz / .tar.gz file", "devctl-bundle")
    .action(async (opts: { since?: string; output: string }) => {
      const sinceMs = opts.since === undefined ? undefined : parseDuration(opts.since);
      const output = resolve(opts.output);
      const archive = /\.(tgz|tar\.gz)$/.test(output);
      const dir = archive ? output.replace(/\.(tgz|tar\.gz)$/, "") : output;
      const ctrl = await runtime.openController("", configFlag(root), false, { allowMissingConfig: true });
      try {
        const written = await writeBundle(runtime, ctrl, dir, { sinceMs });
        if (archive) {
          runtime.archiveDirectory(dir, output);
          runtime.removePath(dir);
        }
        writeOut(`wrote ${archive ? output : `${written.length} files to ${dir}`}\n`);
      } finally {
        await ctrl.close({ detach: true });
      }
    });
}

/**
 * Writes the evidence a failed run leaves behind, every file redacted (see
 * redactJson, plus every literal secret value the config spells out). Each part is collected on its own: one that fails (no daemon,
 * doctor erroring) is listed in errors.txt instead of losing the rest.
 * Never read: .devctl/secrets.env, keychain values, decrypted SOPS output.
 */
export async function writeBundle(runtime: ClientRuntime, ctrl: Controller, dir: string, opts: { sinceMs?: number; now?: Date }): Promise<string[]> {
  const cfg = ctrl.cfg;
  const detector = new Detector(cfg.secrets.extra_markers, cfg.secrets.extra_patterns, true);
  const written: string[] = [];
  const errors: string[] = [];
  const known = configSecretValues(detector, cfg);
  const put = (name: string, text: string): void => {
    runtime.writeSecretFile(join(dir, name), maskKnownValues(text, known));
    written.push(name);
  };
  const json = (value: unknown): string => `${JSON.stringify(redactJson(detector, value), null, 2)}\n`;
  const part = async (name: string, collect: () => Promise<void>): Promise<void> => {
    try {
      await collect();
    } catch (err) {
      errors.push(`${name}: ${humanMessage(err)}`);
    }
  };
  const now = opts.now ?? new Date();
  const since = opts.sinceMs === undefined ? undefined : new Date(now.getTime() - opts.sinceMs).toISOString();

  let snap: Awaited<ReturnType<Controller["status"]>> | undefined;
  await part("status.json", async () => {
    snap = await ctrl.status();
    const { mcp, ...rest } = snap;
    // The MCP bearer token is the one secret the snapshot carries by design.
    put("status.json", json({ ...rest, ...(mcp ? { mcp: { ...mcp, token: undefined } } : {}) }));
  });
  let logs: Awaited<ReturnType<Controller["logs"]>> = [];
  await part("logs.ndjson", async () => {
    logs = (await ctrl.logs({ since })).slice(-BUNDLE_LOG_LIMIT);
    put("logs.ndjson", logs.map((event) => JSON.stringify(redactJson(detector, event))).join("\n") + (logs.length > 0 ? "\n" : ""));
  });
  await part("traces.json", async () => {
    if (!snap) return;
    const traces = [];
    for (const id of failedTraceIds(logs, snap, BUNDLE_TRACE_LIMIT)) {
      traces.push(await ctrl.getTrace(id));
    }
    put("traces.json", json(traces));
  });
  await part("traffic.json", async () => {
    const page = await ctrl.trafficCallsPage({ since, limit: BUNDLE_TRAFFIC_LIMIT });
    put("traffic.json", json(page.calls));
  });
  await part("doctor.json", async () => {
    put("doctor.json", json(await runtime.runDoctor.execute(cfg)));
  });
  await part("config-diff.json", async () => {
    put("config-diff.json", json(runtime.configDiff(cfg)));
  });
  await part("bootstrap.log", async () => {
    const path = runtime.bootstrapLogPath(cfg.repoRoot);
    if (runtime.fileExists(path)) {
      put("bootstrap.log", detector.redactText(runtime.readTextFile(path)));
    }
  });
  put(
    "versions.txt",
    [
      versionLine(),
      `bun ${process.versions.bun ?? "-"}`,
      `platform ${process.platform} ${process.arch}`,
      `instance ${(snap?.instance?.name ?? cfg.instance.name) || "(checkout)"} slot ${snap?.instance?.slot ?? cfg.instance.slot}`,
      `collected ${now.toISOString()}${since ? ` (logs since ${since})` : ""}`,
      "",
    ].join("\n"),
  );
  if (errors.length > 0) {
    put("errors.txt", `${detector.redactText(errors.join("\n"))}\n`);
  }
  return written;
}
