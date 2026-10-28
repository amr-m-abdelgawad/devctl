// Pages the traffic inspector through RPC `traffic_calls_page` (or the LLM
// inspector through `llm_calls_page`) and prints `{ calls, byCaller }`: how
// many captured calls each caller was given.
//
//   bun traffic.ts [--store llm]
import { parseArgs, RpcClient } from "./rpc.ts";

const method = parseArgs(process.argv.slice(2)).store === "llm" ? "llm_calls_page" : "traffic_calls_page";

type Page = { calls: { caller?: string }[]; nextCursor: string; hasNext: boolean };

const rpc = await RpcClient.open();
await rpc.call("ping", { features: ["log_batch.v1"] });
const byCaller: Record<string, number> = {};
let calls = 0;
let cursor: string | undefined;
for (;;) {
  const page = (await rpc.call(method, { limit: 500, summary: true, ...(cursor === undefined ? {} : { cursor }) }, 60_000)) as Page;
  for (const call of page.calls) {
    calls += 1;
    const caller = call.caller ?? "(none)";
    byCaller[caller] = (byCaller[caller] ?? 0) + 1;
  }
  if (!page.hasNext || page.calls.length === 0) {
    break;
  }
  cursor = page.nextCursor;
}
rpc.close();
console.log(JSON.stringify({ calls, byCaller }));
