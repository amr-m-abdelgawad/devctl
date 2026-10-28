// What the daemon costs while its services are quiet, over `--duration-ms`:
// the time its threads spent on a CPU and how often its main thread ran.
// Prints JSON. The numbers are the scheduler's own (`schedstat`): the tick
// counters in `stat` miss a process that only runs briefly after a timer.
//
//   bun idle.ts [--duration-ms 15000] [--state-dir <dir>]
import { readdirSync, readFileSync } from "node:fs";
import { daemonPid, findStateDir, parseArgs } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const durationMs = Number(args["duration-ms"] ?? "15000");
const pid = daemonPid(args["state-dir"] ?? findStateDir());

type Sample = { onCpuNs: number; mainOnCpuNs: number; mainRuns: number };

// `schedstat` is "<ns on a cpu> <ns waiting for one> <times run>" for one thread.
function sample(): Sample {
  const total: Sample = { onCpuNs: 0, mainOnCpuNs: 0, mainRuns: 0 };
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    let fields: number[];
    try {
      fields = readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").trim().split(" ").map(Number);
    } catch {
      // the thread ended, or this kernel keeps no schedstat
      continue;
    }
    total.onCpuNs += fields[0] ?? 0;
    if (Number(tid) === pid) {
      total.mainOnCpuNs = fields[0] ?? 0;
      total.mainRuns = fields[2] ?? 0;
    }
  }
  return total;
}

function percent(ns: number, seconds: number): number {
  return Math.round((ns / 1e9 / seconds) * 100_000) / 1_000;
}

const startedAt = performance.now();
const before = sample();
await Bun.sleep(durationMs);
const after = sample();
const seconds = (performance.now() - startedAt) / 1000;
console.log(JSON.stringify({
  pid,
  seconds: Math.round(seconds * 10) / 10,
  // Percent of one core. Zero when this kernel keeps no schedstat.
  cpuPercent: percent(after.onCpuNs - before.onCpuNs, seconds),
  mainThreadCpuPercent: percent(after.mainOnCpuNs - before.mainOnCpuNs, seconds),
  mainThreadRunsPerSecond: Math.round((after.mainRuns - before.mainRuns) / seconds),
}));
