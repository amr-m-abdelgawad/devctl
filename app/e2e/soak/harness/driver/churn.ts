// Connection churn through the devctl proxy: POSTs at a fixed rate, each on
// its own connection that is closed after the response, as a client without
// keep-alive sends them. A closed connection leaves its socket in TIME_WAIT
// for 60 s, so the socket table grows to about `rate * 60` rows. Prints one
// JSON object: what was sent, the size of the socket table, and the CPU time
// the daemon, this client and (with --pids) other processes spent over the
// measured window.
//
// The rate is open-loop: request `n` is due at `n / rate` seconds whether or
// not earlier ones have been answered, so a slow daemon cannot lower the load
// it is measured under.
//
//   bun churn.ts --url http://127.0.0.1:18080/v1/chat/completions --rate 130
//                [--warmup-s 70] [--measure-s 60] [--caller load]
//                [--keepalive] [--prompt-bytes 2048] [--pids llm=1234,hog=99]
import { readdirSync, readFileSync } from "node:fs";
import { daemonPid, findStateDir, parseArgs, round, RpcClient, summarizeLatencies } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? "http://127.0.0.1:18080/v1/chat/completions";
const rate = Number(args.rate ?? "130");
const warmupS = Number(args["warmup-s"] ?? "70");
const measureS = Number(args["measure-s"] ?? "60");
const caller = args.caller;
const keepalive = args.keepalive === "1";
const body = JSON.stringify({ model: "soak-model", messages: [{ role: "user", content: "p".repeat(Number(args["prompt-bytes"] ?? "2048")) }] });
const others = (args.pids ?? "").split(",").filter((entry) => entry.includes("=")).map((entry) => {
  const [name, pid] = entry.split("=");
  return { name: name!, pid: Number(pid) };
});
// More requests in flight than this are not sent: the daemon has stopped keeping up.
const MAX_IN_FLIGHT = 512;
const TICKS_PER_SECOND = 100;

const daemon = daemonPid(findStateDir());

type Cpu = { user: number; system: number };

// utime and stime of a whole process, threads that have ended included.
function processCpu(pid: number): Cpu {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { user: Number(fields[11]) / TICKS_PER_SECOND, system: Number(fields[12]) / TICKS_PER_SECOND };
  } catch {
    return { user: 0, system: 0 };
  }
}

type ThreadCpu = { name: string; onCpu: number; user: number; system: number };

// Each live thread of `pid`: its name, the scheduler's time on a CPU, and the tick counters' split of it.
function threadCpu(pid: number): Map<string, ThreadCpu> {
  const out = new Map<string, ThreadCpu>();
  let tids: string[] = [];
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch {
    return out;
  }
  for (const tid of tids) {
    try {
      const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const sched = readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").split(" ");
      out.set(tid, {
        name: Number(tid) === pid ? "main" : stat.slice(stat.indexOf("(") + 1, close),
        onCpu: Number(sched[0]) / 1e9,
        user: Number(fields[11]) / TICKS_PER_SECOND,
        system: Number(fields[12]) / TICKS_PER_SECOND,
      });
    } catch {
      // the thread ended
    }
  }
  return out;
}

// Threads grouped by name with their number dropped ("Bun Pool 3" and "Bun Pool 7" are one group).
function threadGroups(before: Map<string, ThreadCpu>, after: Map<string, ThreadCpu>): { name: string; threads: number; onCpu: number; user: number; system: number }[] {
  const groups = new Map<string, { name: string; threads: number; onCpu: number; user: number; system: number }>();
  for (const [tid, end] of after) {
    const start = before.get(tid) ?? { onCpu: 0, user: 0, system: 0 };
    const name = end.name.replace(/[\s#-]*\d+$/, "");
    const group = groups.get(name) ?? { name, threads: 0, onCpu: 0, user: 0, system: 0 };
    group.threads += 1;
    group.onCpu += end.onCpu - start.onCpu;
    group.user += end.user - start.user;
    group.system += end.system - start.system;
    groups.set(name, group);
  }
  return [...groups.values()]
    .filter((group) => group.onCpu >= 0.01)
    .sort((a, b) => b.onCpu - a.onCpu)
    .map((group) => ({ ...group, onCpu: round(group.onCpu), user: round(group.user), system: round(group.system) }));
}

// Bytes the process has read through read(2) and its kind: a read of a /proc
// file counts, so a lookup that copies the socket table shows up here.
function readBytes(pid: number): number {
  try {
    const match = /^rchar:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/io`, "utf8"));
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function rssBytes(pid: number): number {
  try {
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

// Rows of /proc/net/tcp and tcp6, and how many of them are sockets in TIME_WAIT (state 06).
function socketTable(): { rows: number; timeWait: number; bytes: number } {
  let rows = 0;
  let timeWait = 0;
  let bytes = 0;
  for (const name of ["tcp", "tcp6"]) {
    let text = "";
    try {
      text = readFileSync(`/proc/net/${name}`, "utf8");
    } catch {
      continue;
    }
    bytes += text.length;
    for (const line of text.split("\n")) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 4 && cols[0]!.endsWith(":")) {
        rows += 1;
        timeWait += cols[3] === "06" ? 1 : 0;
      }
    }
  }
  return { rows, timeWait, bytes };
}

type DaemonStatus = { daemon?: { heapBytes?: number; eventLoopLagMs?: number } };

const rpc = await RpcClient.open();
await rpc.call("ping", { features: ["log_batch.v1"] });
async function daemonStatus(): Promise<{ heapBytes: number; eventLoopLagMs: number }> {
  try {
    const status = (await rpc.call("status", null, 10_000)) as DaemonStatus;
    return { heapBytes: status.daemon?.heapBytes ?? 0, eventLoopLagMs: status.daemon?.eventLoopLagMs ?? 0 };
  } catch {
    return { heapBytes: 0, eventLoopLagMs: Number.NaN };
  }
}

let sent = 0;
let ok = 0;
let errors = 0;
let shed = 0;
let inFlight = 0;
let measuring = false;
const latencies: number[] = [];
const statuses: Record<string, number> = {};

async function request(): Promise<void> {
  const counted = measuring;
  const started = performance.now();
  inFlight += 1;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!keepalive) {
      headers.connection = "close";
    }
    if (caller !== undefined) {
      headers["x-devctl-service"] = caller;
    }
    const res = await fetch(url, { method: "POST", headers, body, keepalive });
    await res.arrayBuffer();
    if (counted) {
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (res.status === 200) {
        ok += 1;
        latencies.push(performance.now() - started);
      } else {
        errors += 1;
      }
    }
  } catch {
    if (counted) {
      errors += 1;
    }
  } finally {
    inFlight -= 1;
  }
}

// Sends what is due every millisecond or so until `untilMs` on the monotonic clock.
async function drive(untilMs: number): Promise<void> {
  const startedAt = performance.now();
  let due = 0;
  while (performance.now() < untilMs) {
    const target = Math.floor(((performance.now() - startedAt) / 1000) * rate);
    while (due < target) {
      due += 1;
      if (inFlight >= MAX_IN_FLIGHT) {
        shed += measuring ? 1 : 0;
        continue;
      }
      sent += measuring ? 1 : 0;
      void request();
    }
    await Bun.sleep(1);
  }
}

const series: { second: number; rows: number; daemonCpuPercent: number }[] = [];
async function watch(untilMs: number): Promise<void> {
  const startedAt = performance.now();
  let last = processCpu(daemon);
  let lastAt = startedAt;
  while (performance.now() < untilMs) {
    await Bun.sleep(Math.min(10_000, Math.max(0, untilMs - performance.now())));
    const now = performance.now();
    const cpu = processCpu(daemon);
    series.push({
      second: Math.round((now - startedAt) / 1000),
      rows: socketTable().rows,
      daemonCpuPercent: Math.round(((cpu.user + cpu.system - last.user - last.system) / ((now - lastAt) / 1000)) * 100),
    });
    last = cpu;
    lastAt = now;
  }
}

const begin = performance.now();
const measureFrom = begin + warmupS * 1000;
const end = measureFrom + measureS * 1000;
const watching = watch(end);
await drive(measureFrom);

measuring = true;
const tableBefore = socketTable();
const cpuBefore = { daemon: processCpu(daemon), client: process.cpuUsage(), others: others.map((other) => processCpu(other.pid)) };
const readBefore = readBytes(daemon);
const threadsBefore = threadCpu(daemon);
const measuredFrom = performance.now();
let rssMax = rssBytes(daemon);
let heapMax = 0;
let lagMax = 0;
const sampler = setInterval(() => {
  rssMax = Math.max(rssMax, rssBytes(daemon));
  void daemonStatus().then((status) => {
    heapMax = Math.max(heapMax, status.heapBytes);
    lagMax = Math.max(lagMax, status.eventLoopLagMs);
  });
}, 2_000);
await drive(end);
clearInterval(sampler);
measuring = false;
const seconds = (performance.now() - measuredFrom) / 1000;
const cpuAfter = { daemon: processCpu(daemon), client: process.cpuUsage(cpuBefore.client), others: others.map((other) => processCpu(other.pid)) };
const daemonRead = readBytes(daemon) - readBefore;
const threads = threadGroups(threadsBefore, threadCpu(daemon));
const tableAfter = socketTable();
await watching;

// Requests still in flight are given a moment to finish, then the run is reported as it stands.
for (let waited = 0; inFlight > 0 && waited < 50; waited += 1) {
  await Bun.sleep(100);
}
const last = await daemonStatus();
rpc.close();

const per1000 = (cpu: Cpu): number => (ok === 0 ? Number.NaN : round(((cpu.user + cpu.system) / ok) * 1000));
const spent = (after: Cpu, before: Cpu): Cpu => ({ user: round(after.user - before.user), system: round(after.system - before.system) });
const daemonCpu = spent(cpuAfter.daemon, cpuBefore.daemon);
const clientCpu = { user: round(cpuAfter.client.user / 1e6), system: round(cpuAfter.client.system / 1e6) };
const MIB = 1024 * 1024;
console.log(JSON.stringify({
  load: { rate, keepalive, caller: caller ?? null, seconds: round(seconds) },
  requests: { sent, ok, errors, shed, perSecond: round(ok / seconds), statuses, ...summarizeLatencies(latencies) },
  table: { rowsBefore: tableBefore.rows, rowsAfter: tableAfter.rows, timeWait: tableAfter.timeWait, bytes: tableAfter.bytes },
  // Seconds of CPU over the measured window, and the same per 1,000 answered requests.
  cpu: {
    daemon: { ...daemonCpu, percent: Math.round(((daemonCpu.user + daemonCpu.system) / seconds) * 100), per1000: per1000(daemonCpu) },
    client: { ...clientCpu, percent: Math.round(((clientCpu.user + clientCpu.system) / seconds) * 100), per1000: per1000(clientCpu) },
    ...Object.fromEntries(others.map((other, index) => {
      const cpu = spent(cpuAfter.others[index]!, cpuBefore.others[index]!);
      return [other.name, { ...cpu, percent: Math.round(((cpu.user + cpu.system) / seconds) * 100), per1000: per1000(cpu) }];
    })),
  },
  daemonThreads: threads,
  daemon: {
    pid: daemon,
    rssMaxMiB: Math.round(rssMax / MIB),
    heapMaxMiB: Math.round(Math.max(heapMax, last.heapBytes) / MIB),
    eventLoopLagMaxMs: round(Math.max(lagMax, last.eventLoopLagMs)),
    readMiB: round(daemonRead / MIB),
    readBytesPerRequest: ok === 0 ? Number.NaN : Math.round(daemonRead / ok),
  },
  series,
  loadavg: readFileSync("/proc/loadavg", "utf8").trim().split(" ").slice(0, 3).map(Number),
}));
process.exit(0);
