import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import type { LogFilter, LogPage } from "../../domain/logs/logs.ts";
import { addLogs } from "./logs.ts";

function emptyPage(): LogPage {
  return { events: [], nextCursor: "", prevCursor: "", hasNext: false, hasPrev: false, sessionChanged: false };
}

function runtimeCapturing(seen: { filter?: LogFilter }): ClientRuntime {
  return {
    openController: async () => ({
      logsPage: async (req: LogFilter) => {
        seen.filter = req;
        return emptyPage();
      },
      logs: async (req: LogFilter) => {
        seen.filter = req;
        return [];
      },
      close: async () => undefined,
    }),
    resolveExportPath: (path: string) => path,
  } as unknown as ClientRuntime;
}

async function parseLogs(args: string[]): Promise<LogFilter | undefined> {
  const seen: { filter?: LogFilter } = {};
  const root = new Command();
  root.enablePositionalOptions();
  addLogs(root, runtimeCapturing(seen));
  await root.parseAsync(["node", "devctl", "logs", ...args], { from: "node" });
  return seen.filter;
}

describe("devctl logs --dedupe-request-id", () => {
  test("parses the flag onto the page request", async () => {
    expect((await parseLogs(["--dedupe-request-id"]))?.dedupeRequestId).toBe(true);
  });

  test("omits the flag when it is not passed", async () => {
    expect((await parseLogs([]))?.dedupeRequestId).toBe(false);
  });
});
