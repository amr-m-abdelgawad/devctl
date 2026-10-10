// Sends chat completions through the devctl proxy, then reads back what the
// LLM inspector kept, and prints one JSON object: request latencies, the
// daemon's RSS, and the body bytes the store still holds.
//
//   bun llm-load.ts --url http://127.0.0.1:18080/v1/chat/completions --count 400 --prompt-bytes 131072
import { readFileSync } from "node:fs";
import { daemonPid, findStateDir, parseArgs, RpcClient, summarizeLatencies } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? "http://127.0.0.1:18080/v1/chat/completions";
const count = Number(args.count ?? "400");
const prompt = "p".repeat(Number(args["prompt-bytes"] ?? "131072"));

function vmRssBytes(pid: number): number {
  const match = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return match ? Number(match[1]) * 1024 : 0;
}

const pid = daemonPid(findStateDir());
const rssBefore = vmRssBytes(pid);
let rssMax = rssBefore;
const samples: number[] = [];
let errors = 0;
for (let index = 0; index < count; index += 1) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "soak-model", messages: [{ role: "user", content: `${index} ${prompt}` }] }),
    });
    await res.arrayBuffer();
    if (res.status === 200) {
      samples.push(performance.now() - started);
    } else {
      errors += 1;
    }
  } catch {
    errors += 1;
  }
  if (index % 20 === 0) {
    rssMax = Math.max(rssMax, vmRssBytes(pid));
  }
}
await Bun.sleep(1_000);
rssMax = Math.max(rssMax, vmRssBytes(pid));

type Call = { id: string; request?: unknown; response?: unknown; attributes?: Record<string, unknown> };
type Page = { calls: Call[]; nextCursor: string; hasNext: boolean };
const rpc = await RpcClient.open();
await rpc.call("ping", { features: ["log_batch.v1"] });
let calls = 0;
let withBodies = 0;
let evicted = 0;
let bodyBytes = 0;
let cursor: string | undefined;
for (;;) {
  const page = (await rpc.call("llm_calls_page", { limit: 200, ...(cursor === undefined ? {} : { cursor }) }, 60_000)) as Page;
  for (const call of page.calls) {
    calls += 1;
    if (call.request !== undefined || call.response !== undefined) {
      withBodies += 1;
      bodyBytes += Buffer.byteLength(`${JSON.stringify(call.request ?? "")}\n${JSON.stringify(call.response ?? "")}`);
    }
    if (call.attributes?.body === "evicted") {
      evicted += 1;
    }
  }
  if (!page.hasNext || page.calls.length === 0) {
    break;
  }
  cursor = page.nextCursor;
}
rpc.close();
console.log(JSON.stringify({ requests: { ...summarizeLatencies(samples), errors }, rssBeforeBytes: rssBefore, rssMaxBytes: rssMax, rssAfterBytes: vmRssBytes(pid), calls, withBodies, evicted, bodyBytes }));
