import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { configFlag, writeOut } from "./shared.ts";

export function addWeb(root: Command, runtime: ClientRuntime): void {
  const web = root.command("web").description("Local loopback telemetry and control web UI");
  web
    .command("status")
    .option("--json")
    .action(async (opts: { json?: boolean }) => {
      const ctrl = await runtime.openController("", configFlag(root), false);
      try {
        if (!ctrl.client) {
          if (opts.json) {
            writeOut(`${JSON.stringify({ running: false }, null, 2)}\n`);
            return;
          }
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
  web
    .command("start")
    .option("--print-url", "print the full access link including the control token (sensitive)")
    .action(async (opts: { printUrl?: boolean }) => {
      const ctrl = await runtime.openController("", configFlag(root), true);
      try {
        const started = await ctrl.webStart();
        if (opts.printUrl) {
          // The token lives in the URL fragment; printing it puts a mutation
          // secret into terminal scrollback, so it is opt-in.
          writeOut(`${started.url}\n`);
          return;
        }
        const origin = started.url.split("#")[0] ?? started.url;
        writeOut(`web console: ${origin}\n`);
        writeOut("open it with the one-time access link (contains the control token): devctl web start --print-url\n");
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
