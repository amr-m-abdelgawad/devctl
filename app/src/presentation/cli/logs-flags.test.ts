import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { decodeLogCursor, encodeLogCursor, logRecord, type LogFilter, type LogPage, type LogPageRequest } from "../../domain/logs/logs.ts";
import { addLogs, printAllLogs } from "./logs.ts";

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

describe("devctl logs --all", () => {
  // A daemon that serves three records a page, as a byte-capped page would.
  function pagedDaemon(count: number): { fetch: (request: LogPageRequest) => Promise<LogPage>; requests: LogPageRequest[] } {
    const all = Array.from({ length: count }, (_, index) => logRecord({ seq: index + 1, service: "api", message: `line ${index + 1}` }));
    const requests: LogPageRequest[] = [];
    const cursorAt = (seq: number): string => encodeLogCursor({ session: "s1", seq });
    const fetch = async (request: LogPageRequest): Promise<LogPage> => {
      requests.push(request);
      const size = Math.min(request.limit ?? 500, 3);
      if (request.cursor === undefined) {
        const events = all.slice(-size);
        return { events, prevCursor: cursorAt(events[0]?.seq ?? 0), nextCursor: cursorAt(events.at(-1)?.seq ?? 0), hasPrev: all.length > events.length, hasNext: false, sessionChanged: false };
      }
      const after = decodeLogCursor(request.cursor)?.seq ?? 0;
      const events = all.filter((event) => event.seq > after).slice(0, size);
      const last = events.at(-1)?.seq ?? after;
      return { events, prevCursor: cursorAt(events[0]?.seq ?? after), nextCursor: cursorAt(last), hasPrev: after > 0, hasNext: last < all.length, sessionChanged: false };
    };
    return { fetch, requests };
  }

  test("prints the whole window oldest first, one page at a time", async () => {
    const daemon = pagedDaemon(10);
    const printed: number[] = [];
    await printAllLogs(daemon.fetch, (event) => printed.push(event.seq));
    expect(printed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // One probe for the session, then forward pages from the start; never the unpaged call.
    expect(daemon.requests[0]).toEqual({ direction: "backward", limit: 1 });
    expect(daemon.requests.slice(1).every((request) => request.direction === "forward")).toBe(true);
    expect(decodeLogCursor(daemon.requests[1]?.cursor ?? "")?.seq).toBe(0);
  });

  test("with request-id dedupe, a pair split by a page boundary still collapses", async () => {
    const at = Date.parse("2026-09-19T00:00:00.000Z") * 1_000_000;
    const all = [
      logRecord({ seq: 1, service: "api", message: "line", timeUnixNano: at }),
      logRecord({ seq: 2, service: "api", message: "line", timeUnixNano: at + 1_000_000 }),
      // The service line ends one page and its proxy hop starts the next.
      logRecord({ seq: 3, service: "api", message: "POST /v1/thing", timeUnixNano: at + 2_000_000, attributes: { "devctl.request_id": "req-1" } }),
      logRecord({ seq: 4, service: "api", source: "proxy", message: "", timeUnixNano: at + 7_000_000, attributes: { "devctl.request_id": "req-1", "http.status": 200 } }),
    ];
    const fetch = async (request: LogPageRequest): Promise<LogPage> => {
      const cursorAt = (seq: number): string => encodeLogCursor({ session: "s1", seq });
      if (request.cursor === undefined) {
        return { events: all.slice(-1), prevCursor: cursorAt(4), nextCursor: cursorAt(4), hasPrev: true, hasNext: false, sessionChanged: false };
      }
      const after = decodeLogCursor(request.cursor)?.seq ?? 0;
      const events = all.filter((event) => event.seq > after).slice(0, 3);
      const last = events.at(-1)?.seq ?? after;
      return { events, prevCursor: cursorAt(events[0]?.seq ?? after), nextCursor: cursorAt(last), hasPrev: after > 0, hasNext: last < all.length, sessionChanged: false };
    };
    const printed: number[] = [];
    await printAllLogs(fetch, (event) => printed.push(event.seq), true);
    expect(printed).toEqual([1, 2, 3]);
  });

  test("prints nothing for an empty log", async () => {
    const daemon = pagedDaemon(0);
    const printed: number[] = [];
    await printAllLogs(daemon.fetch, (event) => printed.push(event.seq));
    expect(printed).toEqual([]);
  });
});
