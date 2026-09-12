import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { configFlag, writeOut } from "./shared.ts";

export function addWeb(root: Command, runtime: ClientRuntime): void {
  const web = root.command("web").description("Local read-only telemetry web UI");
  web
    .command("status")
    .option("--json")
    .action(async (opts: { json?: boolean }) => {
      const ctrl = await runtime.openController("", configFlag(root), false);
      try {
        if (!ctrl.client) {
          writeOut("WEB  STOPPED\n");
          return;
        }
        const snap = await ctrl.status();
        if (opts.json) {
          writeOut(JSON.stringify(snap.web ?? { running: false }, null, 2) + "\n");
          return;
        }
        writeOut(`WEB  ${snap.web?.running ? "RUNNING" : "STOPPED"}  ${snap.web?.address ?? ""}\n`);
      } finally {
        await ctrl.close();
      }
    });
  web.command("start").action(async () => {
    const ctrl = await runtime.openController("", configFlag(root), true);
    try {
      await ctrl.webStart();
      const snap = await ctrl.status();
      writeOut(`${snap.web?.address ?? ""}\n`);
    } finally {
      await ctrl.close();
    }
  });
  web.command("stop").action(async () => {
    const ctrl = await runtime.openController("", configFlag(root), true);
    try {
      await ctrl.webStop();
    } finally {
      await ctrl.close();
    }
  });
}
