// Measures the daemon from inside the soak container while a scenario runs,
// and prints one JSON object:
//
// - rpc:      round trips of `ping` on one connection, one at a time.
// - proxy:    GETs through the devctl proxy, one at a time (with --proxy-url).
// - rss:      the daemon's VmRSS from /proc, every 100 ms.
// - pipeline: `status` every second — spooled and in-flight bytes, pauses,
//             persistence loss, and which log store and watchdog run.
//
//   bun probe.ts --duration-ms 30000 [--proxy-url http://127.0.0.1:18080/echo]
//                [--stall log_batch|legacy|both] [--interval-ms 10]
//
// --stall opens clients that authenticate and then never read again, like a
// suspended TUI (log_batch.v1) or an old client (per-record events).
import { readFileSync, statfsSync } from "node:fs";
import { daemonPid, devctlHome, findStateDir, parseArgs, round, RpcClient, summarizeLatencies } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const durationMs = Number(args["duration-ms"] ?? "30000");
const intervalMs = Number(args["interval-ms"] ?? "10");
const proxyUrl = args["proxy-url"];
const stall = args.stall ?? "";

type Pipeline = { inFlightBytes?: number; spooledBytes?: number; paused?: boolean; loss?: number; degraded?: string };
type Status = {
  session_id?: string;
  logs?: { seen?: number; total?: number };
  daemon?: { rssBytes?: number; logs?: Pipeline; logStore?: string; watchdog?: string; eventLoopLagMs?: number };
};

function vmRssBytes(pid: number): number | undefined {
  try {
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

function loadAvg(): number[] {
  try {
    return readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/).slice(0, 3).map(Number);
  } catch {
    return [];
  }
}

function diskFreeBytes(): number {
  const stats = statfsSync(devctlHome());
  return stats.bavail * stats.bsize;
}

const stateDir = findStateDir();
const pid = daemonPid(stateDir);
const deadline = Date.now() + durationMs;
const loadStart = loadAvg();

const stalled: RpcClient[] = [];
for (const kind of stall === "both" ? ["log_batch", "legacy"] : stall === "" ? [] : [stall]) {
  const client = await RpcClient.open(stateDir);
  await client.call("ping", kind === "log_batch" ? { features: ["log_batch.v1"] } : null);
  client.stopReading();
  stalled.push(client);
}

const rpc = await RpcClient.open(stateDir);
await rpc.call("ping", { features: ["log_batch.v1"] });

const rpcSamples: number[] = [];
let rpcErrors = 0;
async function pingLoop(): Promise<void> {
  while (Date.now() < deadline) {
    const started = performance.now();
    try {
      await rpc.call("ping", null, 10_000);
      rpcSamples.push(performance.now() - started);
    } catch {
      rpcErrors += 1;
    }
    await Bun.sleep(intervalMs);
  }
}

const proxySamples: number[] = [];
let proxyErrors = 0;
async function proxyLoop(): Promise<void> {
  if (proxyUrl === undefined) {
    return;
  }
  while (Date.now() < deadline) {
    const started = performance.now();
    try {
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10_000) });
      await res.arrayBuffer();
      if (res.status === 200) {
        proxySamples.push(performance.now() - started);
      } else {
        proxyErrors += 1;
      }
    } catch {
      proxyErrors += 1;
    }
    await Bun.sleep(intervalMs);
  }
}

let rssMax = 0;
let rssLast = 0;
let rssSamples = 0;
async function rssLoop(): Promise<void> {
  while (Date.now() < deadline) {
    const rss = vmRssBytes(pid);
    if (rss !== undefined) {
      rssMax = Math.max(rssMax, rss);
      rssLast = rss;
      rssSamples += 1;
    }
    await Bun.sleep(100);
  }
}

const pipeline = { maxSpooledBytes: 0, maxInFlightBytes: 0, pausedSamples: 0, maxLoss: 0, degraded: [] as string[], samples: 0, statusErrors: 0 };
let lastStatus: Status = {};
let maxEventLoopLagMs = 0;
async function statusLoop(): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const status = (await rpc.call("status", null, 10_000)) as Status;
      lastStatus = status;
      const logs = status.daemon?.logs ?? {};
      pipeline.samples += 1;
      pipeline.maxSpooledBytes = Math.max(pipeline.maxSpooledBytes, logs.spooledBytes ?? 0);
      pipeline.maxInFlightBytes = Math.max(pipeline.maxInFlightBytes, logs.inFlightBytes ?? 0);
      pipeline.maxLoss = Math.max(pipeline.maxLoss, logs.loss ?? 0);
      if (logs.paused === true) {
        pipeline.pausedSamples += 1;
      }
      if (logs.degraded !== undefined && !pipeline.degraded.includes(logs.degraded)) {
        pipeline.degraded.push(logs.degraded);
      }
      maxEventLoopLagMs = Math.max(maxEventLoopLagMs, status.daemon?.eventLoopLagMs ?? 0);
    } catch {
      pipeline.statusErrors += 1;
    }
    await Bun.sleep(1_000);
  }
}

await Promise.all([pingLoop(), proxyLoop(), rssLoop(), statusLoop()]);
rpc.close();
for (const client of stalled) {
  client.close();
}

console.log(JSON.stringify({
  rpc: { ...summarizeLatencies(rpcSamples), errors: rpcErrors },
  proxy: proxyUrl === undefined ? undefined : { ...summarizeLatencies(proxySamples), errors: proxyErrors },
  rss: { maxBytes: rssMax, lastBytes: rssLast, samples: rssSamples },
  pipeline,
  daemon: {
    pid,
    session: lastStatus.session_id,
    logStore: lastStatus.daemon?.logStore,
    watchdog: lastStatus.daemon?.watchdog,
    maxEventLoopLagMs: round(maxEventLoopLagMs),
    seen: lastStatus.logs?.seen,
  },
  events: rpc.events,
  load: { start: loadStart, end: loadAvg() },
  diskFreeBytes: diskFreeBytes(),
}));
process.exit(0);
