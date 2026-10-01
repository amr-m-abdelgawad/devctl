// Proxy capture under load: the LLM inspector's byte budget, and caller
// attribution when a service holds thousands of file descriptors.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gateEnabled, gatedName } from "../gates.ts";
import { CONFIG_HEADER, IMAGE_BUILD_TIMEOUT_MS, MIB, report, SoakContainer, soakEnabled, soakImage, soakQuick, type ProbeResult } from "../harness/soak.ts";

const RPC_P99_MS = 50;
const PROXY_P99_MS = 50;
const RSS_MAX_BYTES = 400 * MIB;
const PROXY_PORT = 18080;

type LlmLoad = {
  requests: { count: number; p50: number; p99: number; max: number; errors: number };
  rssBeforeBytes: number;
  rssMaxBytes: number;
  rssAfterBytes: number;
  calls: number;
  withBodies: number;
  evicted: number;
  bodyBytes: number;
};

describe.skipIf(!soakEnabled || soakQuick)("capture", () => {
  let tag = "";
  const containers: SoakContainer[] = [];

  beforeAll(async () => {
    tag = await soakImage();
  }, IMAGE_BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(containers.map((container) => container.rm()));
  });

  async function container(): Promise<SoakContainer> {
    const started = await SoakContainer.start(tag);
    containers.push(started);
    return started;
  }

  test("the LLM inspector keeps captured bodies within llm.store_max_bytes", async () => {
    const box = await container();
    const budget = 4 * MIB;
    const count = 400;
    const promptBytes = 128 * 1024;
    await box.configure(`${CONFIG_HEADER}project:
  name: soak-llm
proxy:
  enabled: true
  listen: { host: 127.0.0.1, port: ${PROXY_PORT} }
  routes:
    - name: llm-route
      match: { path: /v1 }
      upstream: { service: llm }
llm:
  enabled: true
  store_max_bytes: ${budget}
  sources:
    - name: local-llm
      type: proxy
      via: { route: llm-route }
services:
  llm:
    command: [bun, /soak/driver/llm-upstream.ts, "18082", --completion-bytes, "32768"]
    ports: { http: 18082 }
    health: { type: http, url: "http://127.0.0.1:\${services.llm.ports.http}/health", interval_seconds: 1 }
`);
    await box.devctl(["start", "llm", "--wait", "--timeout", "60s"]);
    const load = await box.driver<LlmLoad>("llm-load.ts", ["--url", `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, "--count", String(count), "--prompt-bytes", String(promptBytes)], { timeoutMs: 300_000 });
    report("LLM capture budget", {
      budgetMiB: budget / MIB,
      sentMiB: Math.round((count * (promptBytes + 32 * 1024)) / MIB),
      retainedBodyMiB: Math.round((load.bodyBytes / MIB) * 100) / 100,
      calls: load.calls,
      withBodies: load.withBodies,
      evicted: load.evicted,
      requests: load.requests,
      rssMiB: { before: Math.round(load.rssBeforeBytes / MIB), max: Math.round(load.rssMaxBytes / MIB), after: Math.round(load.rssAfterBytes / MIB) },
    });
    await box.devctl(["down"], { allowFail: true });

    expect(load.requests.errors).toBe(0);
    expect(load.calls).toBe(count);
    expect(load.withBodies).toBeGreaterThan(0);
    // The store counts each body as its search text; the JSON read back over RPC is a little larger.
    expect(load.bodyBytes).toBeLessThanOrEqual(budget * 1.1);
    expect(load.rssMaxBytes).toBeLessThan(RSS_MAX_BYTES);
  }, 600_000);

  for (const hogFds of [0, 5_000]) {
  const attributionName = hogFds === 0 ? "callers are attributed (control: no service holds extra fds)" : `callers are attributed while another service holds ${hogFds} file descriptors`;
  test.skipIf(!gateEnabled("caller-attribution"))(gatedName("caller-attribution", attributionName), async () => {
    const box = await container();
    const count = 500;
    await box.configure(`${CONFIG_HEADER}project:
  name: soak-attribution
proxy:
  enabled: true
  listen: { host: 127.0.0.1, port: ${PROXY_PORT} }
  routes:
    - name: echo-route
      match: { path: /echo }
      upstream: { service: echo }
      inspect: true
services:
  fdhog:
    command: [bun, /soak/driver/fdhog.ts, "${hogFds}"]
  echo:
    command: [bun, /soak/driver/echo.ts, "18081"]
    ports: { http: 18081 }
    health: { type: http, url: "http://127.0.0.1:\${services.echo.ports.http}/health", interval_seconds: 1 }
  client:
    command: [bun, /soak/driver/client.ts, --url, "http://127.0.0.1:${PROXY_PORT}/echo/x", --count, "${count}", --interval-ms, "20", --delay-ms, "2000"]
    restart: { policy: never }
`);
    await box.devctl(["start", "fdhog", "echo", "--wait", "--timeout", "60s"]);
    const hog = (await box.status()).services.fdhog!.pid;
    const fds = Number((await box.sh(`ls /proc/${hog}/fd | wc -l`)).stdout.trim());
    const probe = box.driver<ProbeResult>("probe.ts", ["--duration-ms", "20000"], { timeoutMs: 60_000 });
    await box.devctl(["start", "client"]);
    const measured = await probe;
    await box.waitDone("client");
    const traffic = await box.driver<{ calls: number; byCaller: Record<string, number> }>("traffic.ts");
    const summary = (await box.devctl(["logs", "client", "--search", "client done", "--json"])).stdout;
    const p99 = Number(/p99=([\d.]+)/.exec(summary)?.[1] ?? "NaN");
    const errors = Number(/errors=(\d+)/.exec(summary)?.[1] ?? "NaN");
    report(`attribution, ${hogFds} fds held`, { fdhogFds: fds, traffic, clientP99Ms: p99, clientErrors: errors, rpc: measured.rpc, rssMaxMiB: Math.round(measured.rss.maxBytes / MIB) });
    await box.devctl(["down"], { allowFail: true });

    expect(fds).toBeGreaterThanOrEqual(hogFds);
    expect(errors).toBe(0);
    expect(traffic.calls).toBeGreaterThanOrEqual(count);
    expect(traffic.byCaller.client ?? 0).toBeGreaterThanOrEqual(Math.ceil(traffic.calls * 0.99));
    expect(p99).toBeLessThan(PROXY_P99_MS);
    expect(measured.rpc.p99).toBeLessThan(RPC_P99_MS);
    expect(measured.rss.maxBytes).toBeLessThan(RSS_MAX_BYTES);
  }, 300_000);
  }
});
