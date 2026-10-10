// Pages a service's log backward through RPC `logs_page`, from the newest
// record to the start of the window, the way the TUI and MCP page history,
// and prints one JSON object: page latencies plus the gap-free check of what
// came back (numbers.ts).
//
//   bun page.ts --service flood --name flood --count N [--limit 5000]
import { checkNumbers, type StoredRow } from "./numbers.ts";
import { parseArgs, RpcClient, summarizeLatencies } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const service = args.service ?? "flood";
const name = args.name ?? service;
const count = Number(args.count ?? "0");
const limit = Number(args.limit ?? "5000");
// A page cut short by the read budget can be empty with more to come.
const MAX_STALLED_PAGES = 5;

type Page = { events: { seq: number; body: unknown; timestamp: string }[]; prevCursor: string; hasPrev: boolean };

const rpc = await RpcClient.open();
await rpc.call("ping", { features: ["log_batch.v1"] });
const pages: StoredRow[][] = [];
const pageMs: number[] = [];
let emptyPages = 0;
let stalled = 0;
let cursor: string | undefined;
for (;;) {
  const started = performance.now();
  const page = (await rpc.call("logs_page", { services: [service], direction: "backward", limit, ...(cursor === undefined ? {} : { cursor }) }, 60_000)) as Page;
  pageMs.push(performance.now() - started);
  pages.unshift(page.events.map((event) => ({ seq: event.seq, body: event.body, timestamp: event.timestamp })));
  if (page.events.length === 0) {
    emptyPages += 1;
  }
  stalled = page.prevCursor === cursor ? stalled + 1 : 0;
  if (!page.hasPrev || stalled >= MAX_STALLED_PAGES) {
    break;
  }
  cursor = page.prevCursor;
}
rpc.close();
const rows = pages.flat();
console.log(JSON.stringify({ pages: pages.length, emptyPages, stalledAtEnd: stalled >= MAX_STALLED_PAGES, pageMs: summarizeLatencies(pageMs), ...checkNumbers(rows, name, count) }));
