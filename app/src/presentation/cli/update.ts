import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { DAEMON_RESTART_HINT } from "../../domain/update.ts";
import { ExitGeneral } from "../../shared/errors.ts";
import { writeOut } from "./shared.ts";

export function addUpdate(root: Command, runtime: ClientRuntime): void {
  root
    .command("update")
    .description("check GitHub Releases and install when the install method is known")
    .option("--json", "machine-readable output")
    .option("--check", "report only; do not install")
    .action(async (opts: { json?: boolean; check?: boolean }) => {
      const result = await runtime.checkUpdate();
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      writeOut(`current  ${result.current}\n`);
      writeOut(`latest   ${result.latest || "(unavailable)"}\n`);
      writeOut(`channel  ${result.kind}\n`);
      if (!result.newer) {
        if (result.latest !== "") {
          writeOut("up to date\n");
        }
        return;
      }
      writeOut(`install  ${result.hint}\n`);
      if (opts.check || !result.command) {
        return;
      }
      writeOut(`installing via ${result.kind}…\n`);
      const applied = await runtime.applyUpdate(result.command, true);
      if (applied.code !== 0) {
        process.exitCode = ExitGeneral;
        return;
      }
      writeOut(`updated to ${result.latest}; ${DAEMON_RESTART_HINT}\n`);
    });
}
