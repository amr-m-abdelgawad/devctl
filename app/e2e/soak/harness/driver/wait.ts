// Waits until a service's log holds a line matching `--search`, then until
// the daemon stops taking in records (`logs.seen` unchanged for a second),
// and prints JSON. Exits 1 on timeout.
//
// It does not wait for `daemon.logs` to read zero: the worker's pipeline
// stats go stale once output stops (test/findings/worker-pipeline-stats).
//
//   bun wait.ts --service flood --search "flood done" [--timeout-ms 120000] [--state-dir <dir>]
import { parseArgs, RpcClient } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const service = args.service ?? "flood";
const search = args.search ?? `${service} done`;
const timeoutMs = Number(args["timeout-ms"] ?? "120000");
const QUIET_MS = 1_000;
const started = Date.now();
const deadline = started + timeoutMs;

type Page = { events?: unknown[] };
type Status = { logs?: { seen?: number } };

const rpc = await RpcClient.open(args["state-dir"]);
await rpc.call("ping", { features: ["log_batch.v1"] });

let foundAfterMs = -1;
while (Date.now() < deadline) {
  const page = (await rpc.call("logs_page", { services: [service], search, limit: 1 })) as Page;
  if ((page.events ?? []).length > 0) {
    foundAfterMs = Date.now() - started;
    break;
  }
  await Bun.sleep(250);
}

let quietAfterMs = -1;
let seen = -1;
let quietSince = Date.now();
while (foundAfterMs >= 0 && Date.now() < deadline) {
  const status = (await rpc.call("status")) as Status;
  const now = status.logs?.seen ?? 0;
  if (now !== seen) {
    seen = now;
    quietSince = Date.now();
  } else if (Date.now() - quietSince >= QUIET_MS) {
    // Past the session writer's 100 ms batch.
    await Bun.sleep(500);
    quietAfterMs = Date.now() - started;
    break;
  }
  await Bun.sleep(200);
}
rpc.close();
const ok = foundAfterMs >= 0 && quietAfterMs >= 0;
console.log(JSON.stringify({ ok, foundAfterMs, quietAfterMs, seen }));
process.exit(ok ? 0 : 1);
