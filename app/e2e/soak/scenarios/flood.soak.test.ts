// Floods one service through the FIFO path and through the pipe path while
// the daemon is measured from inside the container. Every case requires:
// RPC ping p99 and proxy p99 under 50 ms, daemon RSS under 400 MB, the log
// worker running, and the flood's numbered lines gap-free and in order both
// in the persisted session and in what `devctl logs` returns.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IMAGE_BUILD_TIMEOUT_MS, MIB, report, SoakContainer, soakEnabled, soakImage, soakQuick, type ProbeResult, type VerifyResult } from "../harness/soak.ts";

const RPC_P99_MS = 50;
const PROXY_P99_MS = 50;
const RSS_MAX_BYTES = 400 * MIB;
const PROXY_PORT = 18080;
const ECHO_PORT = 18081;

type FloodCase = {
  name: string;
  path: "fifo" | "pipe";
  /** Lines per second; 0 writes as fast as the reader takes them. */
  rate: number;
  count: number;
  init?: boolean;
  /** In the PR subset (DEVCTL_SOAK_QUICK=1). */
  quick?: boolean;
};

const CASES: FloodCase[] = [
  { name: "FIFO flood at 15k lines/s", path: "fifo", rate: 15_000, count: 300_000, quick: true },
  { name: "FIFO flood at 30k lines/s", path: "fifo", rate: 30_000, count: 600_000 },
  { name: "FIFO unpaced burst", path: "fifo", rate: 0, count: 600_000 },
  { name: "pipe flood at 15k lines/s", path: "pipe", rate: 15_000, count: 300_000 },
  { name: "pipe flood at 30k lines/s", path: "pipe", rate: 30_000, count: 600_000 },
  { name: "pipe unpaced burst", path: "pipe", rate: 0, count: 600_000 },
  { name: "FIFO flood at 15k lines/s under --init", path: "fifo", rate: 15_000, count: 300_000, init: true },
  { name: "pipe unpaced burst under --init", path: "pipe", rate: 0, count: 600_000, init: true },
];

function floodConfig(flood: FloodCase): string {
  return `# yaml-language-server: $schema=https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/schema/devctl.config.schema.json
version: 1
project:
  name: soak-flood
proxy:
  enabled: true
  listen: { host: 127.0.0.1, port: ${PROXY_PORT} }
  routes:
    - name: echo-route
      match: { path: /echo }
      upstream: { service: echo }
services:
  echo:
    command: [bun, /soak/driver/echo.ts, "${ECHO_PORT}"]
    ports: { http: ${ECHO_PORT} }
    health: { type: http, url: "http://127.0.0.1:\${services.echo.ports.http}/health", interval_seconds: 1 }
  flood:
    command: [bun, /soak/driver/flood.ts, --rate, "${flood.rate}", --count, "${flood.count}", --name, flood]
    restart: { policy: never }
`;
}

// Long enough for the offered load plus the drain behind it.
function probeMs(flood: FloodCase): number {
  const writeMs = flood.rate > 0 ? (flood.count / flood.rate) * 1000 : 25_000;
  return Math.round(writeMs + 10_000);
}

const cases = CASES.filter((flood) => !soakQuick || flood.quick === true);

describe.skipIf(!soakEnabled)("flood", () => {
  let tag = "";
  const containers: SoakContainer[] = [];

  beforeAll(async () => {
    tag = await soakImage();
  }, IMAGE_BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(containers.map((container) => container.rm()));
  });

  for (const flood of cases) {
    test(flood.name, async () => {
      const container = await SoakContainer.start(tag, { init: flood.init });
      containers.push(container);
      await container.configure(floodConfig(flood));
      // The daemon inherits this PATH; a failing mkfifo first on it forces pipes.
      const path = flood.path === "pipe" ? { PATH: "/soak/nofifo:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } : undefined;
      await container.devctl(["start", "echo", "--wait", "--timeout", "60s"], { env: path, timeoutMs: 90_000 });

      const probe = container.driver<ProbeResult>("probe.ts", ["--duration-ms", String(probeMs(flood)), "--proxy-url", `http://127.0.0.1:${PROXY_PORT}/echo`], { timeoutMs: probeMs(flood) + 60_000 });
      await Bun.sleep(1_000);
      await container.devctl(["start", "flood"], { env: path });
      const fifos = await container.sh('ls "$DEVCTL_HOME"/state/*/stdio/fifo/ 2>/dev/null | grep -c "^flood-" || true');
      const measured = await probe;
      await container.driver("wait.ts", ["--service", "flood", "--search", "flood done", "--timeout-ms", "180000"], { timeoutMs: 200_000 });

      const status = await container.status();
      const persisted = await container.driver<VerifyResult>("verify.ts", ["--session-dir", `/work/home/logs/session-${status.session_id}`, "--name", "flood", "--count", String(flood.count)], { timeoutMs: 120_000 });
      const listed = await container.sh(`devctl logs flood --all --json | bun /soak/driver/verify.ts --stdin --name flood --count ${flood.count}`, { timeoutMs: 120_000 });
      const logs = JSON.parse(listed.stdout.trim().split("\n").at(-1) ?? "{}") as VerifyResult;
      report(flood.name, {
        path: flood.path,
        fifoStreams: Number(fifos.stdout.trim()),
        rpc: measured.rpc,
        proxy: measured.proxy,
        rssMaxMiB: Math.round(measured.rss.maxBytes / MIB),
        pipeline: measured.pipeline,
        daemon: measured.daemon,
        load: measured.load,
        diskFreeGiB: Math.round(measured.diskFreeBytes / MIB / 1024),
        persisted: { records: persisted.records, complete: persisted.complete, missing: persisted.missingInside, duplicates: persisted.duplicates, outOfOrder: persisted.outOfOrder, parts: persisted.files.length },
        logs: { records: logs.records, first: logs.first, last: logs.last, contiguousTail: logs.contiguousTail },
      });
      await container.devctl(["down"], { allowFail: true });

      expect(Number(fifos.stdout.trim()) > 0).toBe(flood.path === "fifo");
      expect(measured.daemon.logStore).toBe("worker");
      expect(measured.rpc.errors).toBe(0);
      expect(measured.rpc.p99).toBeLessThan(RPC_P99_MS);
      expect(measured.proxy?.errors).toBe(0);
      expect(measured.proxy?.p99 ?? Number.POSITIVE_INFINITY).toBeLessThan(PROXY_P99_MS);
      expect(measured.rss.maxBytes).toBeLessThan(RSS_MAX_BYTES);
      expect(persisted.complete).toBe(true);
      expect(persisted.outOfOrder).toBe(0);
      expect(logs.contiguousTail).toBe(true);
      expect(logs.outOfOrder).toBe(0);
    }, probeMs(flood) + 6 * 60_000);
  }
});
