import { Command } from "commander";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { stringify } from "yaml";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { humanMessage } from "../../shared/errors.ts";
import { supervisorRestartAdvice } from "../../domain/service/services.ts";
import { formatComposeImport, importComposeYaml } from "../../application/compose-import.ts";
import { configFlag, writeOut } from "./shared.ts";
import { resolveSetupTarget } from "./setup.ts";

export function addReload(root: Command, runtime: ClientRuntime): void {
  root.command("reload").description("reload configuration").action(async () => {
    const ctrl = await runtime.openController("", configFlag(root), true);
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

export function addConfig(root: Command, runtime: ClientRuntime): void {
  const cfg = root.command("config");
  cfg
    .command("validate")
    .option("--json")
    .action((opts: { json?: boolean }) => {
      try {
        const loaded = runtime.load("", configFlag(root));
        const issues = runtime.validate(loaded);
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
      const loaded = runtime.load("", configFlag(root));
      const entries = runtime.configDiff(loaded);
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
      const loaded = runtime.load("", configFlag(root));
      if (opts.json) {
        writeOut(JSON.stringify(loaded, null, 2) + "\n");
        return;
      }
      writeOut(stringify(loaded));
    });
  cfg
    .command("import")
    .command("compose")
    .argument("<file>", "docker-compose.yml or compose.yaml")
    .option("--write", "write mapped fields under .devctl/config.yaml")
    .action((file: string, opts: { write?: boolean }) => {
      const text = runtime.readTextFile(file);
      const { repo, cfgPath } = resolveSetupTarget("", configFlag(root));
      const result = importComposeYaml(text, basename(repo));
      const issues = runtime.validateConfigText(repo, cfgPath, result.yaml);
      writeOut(formatComposeImport(result));
      if (issues.length > 0) {
        writeOut(`validation:\n${issues.map((issue) => `  ${issue}`).join("\n")}\n`);
        if (opts.write === true) {
          throw new Error("refusing to write an invalid mapping");
        }
        return;
      }
      if (opts.write !== true) {
        writeOut("dry-run; pass --write to save under .devctl/config.yaml\n");
        return;
      }
      if (runtime.fileExists(cfgPath)) {
        throw new Error(`configuration already exists at ${cfgPath}; not overwriting`);
      }
      mkdirSync(dirname(cfgPath), { recursive: true });
      runtime.writeTextFile(cfgPath, result.yaml);
      writeOut(`wrote ${cfgPath}\n`);
    });
}
