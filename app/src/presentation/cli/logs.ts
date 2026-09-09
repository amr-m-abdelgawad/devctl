import { Command } from "commander";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import type { LogEvent, LogPage } from "../../domain/logs/logs.ts";
import { configFlag, writeOut } from "./shared.ts";

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

export function addLogs(root: Command, runtime: ClientRuntime): void {
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
    .option("--all", "print the full matching history instead of the latest page")
    .action(async (services: string[], opts: { level?: string; search?: string; regex?: boolean; source?: string; since?: string; until?: string; output?: string; json?: boolean; follow?: boolean; all?: boolean }) => {
      const ctrl = await runtime.openController("", configFlag(root), true);
      try {
        // Resolved against this process's own cwd before it crosses the RPC
        // boundary: the daemon may be a long-running background process with
        // an unrelated cwd, so a relative path must not be resolved there.
        const exportPath = opts.output ? runtime.resolveExportPath(opts.output) : undefined;
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
        if (exportPath || opts.all === true) {
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
          return;
        }
        const page = await ctrl.logsPage({
          services,
          level: opts.level,
          search: opts.search,
          regex: opts.regex,
          source: opts.source,
          since: opts.since,
          until: opts.until,
          direction: "backward",
        });
        if (opts.json) {
          writeOut(JSON.stringify(page.events, null, 2) + "\n");
          return;
        }
        for (const ev of page.events) {
          writeOut(formatLogLineForCli(ev));
        }
        if (page.hasPrev) {
          writeOut(`… older matching events omitted; pass --all for the full history\n`);
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
      const ctrl = await runtime.openController("", configFlag(root), true);
      try {
        const exportPath = runtime.resolveExportPath(opts.output);
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
// reachable by manually opening that file. runtime.discover() only needs to find
// the repo, not load a valid config, since the config is often exactly
// what's broken when this log is worth reading.
export function addDaemon(root: Command, runtime: ClientRuntime): void {
  root
    .command("daemon")
    .command("logs")
    .option("-f, --follow", "keep printing new lines until interrupted")
    .action(async (opts: { follow?: boolean }) => {
      const { repoRoot } = runtime.discover("", configFlag(root));
      const path = runtime.bootstrapLogPath(repoRoot);
      let printed = 0;
      const printNew = (): void => {
        if (!runtime.fileExists(path)) {
          return;
        }
        const text = runtime.readTextFile(path);
        if (text.length > printed) {
          writeOut(text.slice(printed));
          printed = text.length;
        }
      };
      if (!runtime.fileExists(path)) {
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
