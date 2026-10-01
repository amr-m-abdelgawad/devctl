// The proxy probe's upstream: answers at once on 127.0.0.1:<port>.
//
//   bun echo.ts <port>
const port = Number(process.argv[2] ?? process.env.SERVICE_PORT ?? "18081");

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const path = new URL(req.url).pathname;
    return new Response(path === "/health" ? "ok" : `echo ${path}`);
  },
});
