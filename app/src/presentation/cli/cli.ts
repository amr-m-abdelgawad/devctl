import { Command } from "commander";
import { defaultConfig } from "../../domain/config/types.ts";
import type { ClientRuntime, DaemonLauncher } from "../../application/client-runtime.ts";
import { humanMessage, exitCode } from "../../shared/errors.ts";
import { runTui } from "../tui/index.tsx";
import { completeLine, completionScript } from "./complete.ts";
import { versionLine } from "../../version.ts";
import { addAuth } from "./auth.ts";
import { addConfig, addReload } from "./config.ts";
import { addAttach, addDown, addEnv, addExec, addRestart, addRun, addStart, addStatus, addStop } from "./lifecycle.ts";
import { addInstances } from "./instances.ts";
import { addBundle, addTest } from "./harness.ts";
import { addDaemon, addLogs } from "./logs.ts";
import { addLlm } from "./llm.ts";
import { addTraffic } from "./traffic.ts";
import { addMcp, addProxy } from "./listeners.ts";
import { addWeb } from "./web.ts";
import { addUpdate } from "./update.ts";
import { configFlag, isStdoutClosed, writeOut } from "./shared.ts";

export { followLogs } from "./logs.ts";

export function newRoot(runtime: ClientRuntime, launchDaemon: DaemonLauncher): Command {
  const root = new Command();
  root
    .name("devctl")
    .description("Local development orchestrator")
    .version(versionLine(), "-V, --version", "print version")
    .option("--config <path>", "path to config file or .devctl directory")
    .option("--instance <name>", "work on a named stack of this checkout (default: the checkout's own; env DEVCTL_INSTANCE)")
    .enablePositionalOptions();
  // Every per-stack path (state, socket, tokens, containers, port slot) is
  // derived from DEVCTL_INSTANCE, and a spawned supervisor inherits it.
  root.hook("preAction", () => {
    const { instance } = root.opts<{ instance?: string }>();
    if (instance !== undefined) {
      process.env.DEVCTL_INSTANCE = instance;
    }
  });
  root.command("version").description("print version").action(() => {
    writeOut(`${versionLine()}\n`);
  });
  root.action(async () => {
    const opts = root.opts<{ config?: string }>();
    await runTui(runtime, opts.config ?? "");
  });
  addStart(root, runtime);
  addStop(root, runtime);
  addRestart(root, runtime);
  addRun(root, runtime);
  addExec(root, runtime);
  addEnv(root, runtime);
  addStatus(root, runtime);
  addDown(root, runtime);
  addInstances(root, runtime);
  addTest(root, runtime);
  addBundle(root, runtime);
  addLogs(root, runtime);
  addLlm(root, runtime);
  addTraffic(root, runtime);
  addDaemon(root, runtime);
  addDoctor(root, runtime);
  addSetup(root, runtime);
  addAuth(root, runtime);
  addProxy(root, runtime);
  addMcp(root, runtime);
  addWeb(root, runtime);
  addConfig(root, runtime);
  addReload(root, runtime);
  addAttach(root, runtime);
  addCompletion(root, runtime);
  addUpdate(root, runtime);
  addSupervisor(root, launchDaemon);
  return root;
}

function addDoctor(root: Command, runtime: ClientRuntime): void {
  root
    .command("doctor")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const cfg = runtime.load("", configFlag(root));
      const report = await runtime.runDoctor.execute(cfg);
      if (opts.json) {
        writeOut(JSON.stringify(report, null, 2) + "\n");
      } else {
        writeOut(runtime.formatDoctor(report));
      }
      if (report.issues > 0) {
        process.exitCode = 2;
      }
    });
}

function addSetup(root: Command, runtime: ClientRuntime): void {
  root
    .command("setup")
    .option("--force", "overwrite an existing configuration")
    .action(async (opts: { force?: boolean }) => {
      await runtime.runSetup("", configFlag(root), opts.force === true);
    });
}

function addCompletion(root: Command, runtime: ClientRuntime): void {
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
        const cfg = runtime.load("", configFlag(root));
        writeOut(completeLine(prefix, cfg).join("\n") + "\n");
      } catch {
        writeOut(completeLine(prefix, defaultConfig()).join("\n") + "\n");
      }
    });
}

function addSupervisor(root: Command, launchDaemon: DaemonLauncher): void {
  root
    .command("_supervisor")
    .option("--repo <path>", "repository root")
    .action(async (opts: { repo?: string }) => {
      await launchDaemon(opts.repo ?? "", configFlag(root));
    });
}

export async function execute(runtime: ClientRuntime, launchDaemon: DaemonLauncher): Promise<void> {
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (isStdoutClosed(err)) {
      process.exit(0);
    }
  });
  try {
    await newRoot(runtime, launchDaemon).parseAsync(process.argv);
  } catch (err) {
    process.stderr.write(humanMessage(err) + "\n");
    process.exit(exitCode(err));
  }
}
