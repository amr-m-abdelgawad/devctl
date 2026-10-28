// The proxy probe's upstream: answers on 127.0.0.1:<port>, at once or after
// `--delay-ms`.
//
//   bun echo.ts <port> [--delay-ms 30]
import { parseArgs } from "./rpc.ts";

const port = Number(process.argv[2] ?? process.env.SERVICE_PORT ?? "18081");
const delayMs = Number(parseArgs(process.argv.slice(3))["delay-ms"] ?? "0");

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") {
      return new Response("ok");
    }
    if (delayMs > 0) {
      await Bun.sleep(delayMs);
    }
    return new Response(`echo ${path}`);
  },
});
