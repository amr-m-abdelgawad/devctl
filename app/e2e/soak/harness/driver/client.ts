// A service that calls an upstream through the devctl proxy, one request at
// a time, and logs `client done count=<n> errors=<n> p50=<ms> p99=<ms> max=<ms>`.
// The proxy attributes each call to this service by its socket. Each call
// opens a connection and closes it after the response, unless `--keepalive`
// reuses one connection the way an SDK's pool does.
//
//   bun client.ts --url http://127.0.0.1:18080/echo/x --count 500 [--interval-ms 20] [--delay-ms 2000] [--keepalive]
import { parseArgs, summarizeLatencies } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? "http://127.0.0.1:18080/echo/x";
const count = Number(args.count ?? "500");
const intervalMs = Number(args["interval-ms"] ?? "20");
const keepalive = args.keepalive === "1";
await Bun.sleep(Number(args["delay-ms"] ?? "2000"));

const samples: number[] = [];
let errors = 0;
for (let index = 0; index < count; index += 1) {
  const started = performance.now();
  try {
    // Without --keepalive: a fresh connection each time, so each call needs its own attribution.
    const res = await (keepalive ? fetch(url) : fetch(url, { keepalive: false, headers: { connection: "close" } }));
    await res.arrayBuffer();
    if (res.status === 200) {
      samples.push(performance.now() - started);
    } else {
      errors += 1;
    }
  } catch {
    errors += 1;
  }
  await Bun.sleep(intervalMs);
}
const stats = summarizeLatencies(samples);
console.log(`client done count=${count} errors=${errors} p50=${stats.p50} p99=${stats.p99} max=${stats.max}`);
setInterval(() => undefined, 1 << 30);
