// Sends spans that each carry one large attribute to the daemon's OTLP
// receiver, as LLM tracing does with whole prompts, and prints one JSON
// object: what was accepted, the daemon's own (anonymous) memory along the
// way, and how many spans of the first and of the last trace it still holds.
//
//   bun span-load.ts --url http://127.0.0.1:4318/v1/traces --count 6000 --attribute-bytes 100000
import { readFileSync } from "node:fs";
import { daemonPid, findStateDir, parseArgs, RpcClient } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? "http://127.0.0.1:4318/v1/traces";
const count = Number(args.count ?? "6000");
const prompt = "p".repeat(Number(args["attribute-bytes"] ?? "100000"));

const pid = daemonPid(findStateDir());
function anonBytes(): number {
  const match = /RssAnon:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return match ? Number(match[1]) * 1024 : 0;
}
const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

const anonBefore = anonBytes();
let anonMax = anonBefore;
// The highest reading over the second half: a store that only grows keeps climbing here.
let anonLateMax = 0;
let refused = 0;
for (let index = 1; index <= count; index += 1) {
  const now = BigInt(Date.now()) * 1_000_000n;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
        scopeSpans: [{
          spans: [{
            traceId: hex(index, 32),
            spanId: hex(index, 16),
            name: "chat",
            kind: 3,
            startTimeUnixNano: String(now),
            endTimeUnixNano: String(now + 1_000_000n),
            attributes: [{ key: "gen_ai.prompt", value: { stringValue: `${index} ${prompt}` } }],
          }],
        }],
      }],
    }),
  });
  await res.arrayBuffer();
  if (!res.ok) {
    refused += 1;
  }
  if (index % 50 === 0) {
    const anon = anonBytes();
    anonMax = Math.max(anonMax, anon);
    if (index > count / 2) {
      anonLateMax = Math.max(anonLateMax, anon);
    }
  }
}
await Bun.sleep(3_000);

type Trace = { tree?: { spans?: unknown[] } };
const rpc = await RpcClient.open();
await rpc.call("ping", { features: ["log_batch.v1"] });
const spansOf = async (index: number): Promise<number> => ((await rpc.call("get_trace", { trace_id: hex(index, 32) }, 30_000)) as Trace).tree?.spans?.length ?? 0;
const firstTraceSpans = await spansOf(1);
const lastTraceSpans = await spansOf(count);
rpc.close();
console.log(JSON.stringify({ sent: count, refused, anonBeforeBytes: anonBefore, anonMaxBytes: anonMax, anonLateMaxBytes: anonLateMax, anonSettledBytes: anonBytes(), firstTraceSpans, lastTraceSpans }));
