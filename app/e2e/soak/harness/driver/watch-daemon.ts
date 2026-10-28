// Samples the daemon over a long run: its resident memory, the container's
// working set (what the memory guard and `docker stats` go by), and the
// things that must not pile up: descriptors, threads, zombies, service
// FIFOs. Prints one JSON object with every sample.
//
//   bun watch-daemon.ts [--duration-ms 900000] [--interval-ms 10000] [--append <file>]
//
// `--append` also writes each sample to a file as it is taken, one JSON
// object a line, so a run of many hours can be read while it goes.
//
// Time is counted on a clock that stops while the machine sleeps, so a run on
// a laptop that sleeps part-way goes on from where it was. `pausedS` is how
// far the wall clock has run ahead of it: the time spent asleep so far.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonPid, findStateDir, parseArgs } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const durationMs = Number(args["duration-ms"] ?? "900000");
const intervalMs = Number(args["interval-ms"] ?? "10000");
const appendTo = args.append;
const stateDir = findStateDir();
const MIB = 1024 * 1024;

function count(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function workingSetBytes(): number {
  try {
    const current = Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
    const inactive = Number(/^inactive_file (\d+)$/m.exec(readFileSync("/sys/fs/cgroup/memory.stat", "utf8"))?.[1] ?? "0");
    return current - inactive;
  } catch {
    return 0;
  }
}

// Zombies in the container, and how many of them the daemon itself has not reaped.
function zombies(daemon: number): { all: number; ofDaemon: number } {
  const found = { all: 0, ofDaemon: 0 };
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const [state, parent] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (state === "Z") {
        found.all += 1;
        found.ofDaemon += Number(parent) === daemon ? 1 : 0;
      }
    } catch {
      // exited meanwhile
    }
  }
  return found;
}

type Sample = { atS: number; pausedS: number; pid: number; rssMiB: number; anonMiB: number; fileMiB: number; workingSetMiB: number; fds: number; threads: number; zombies: number; daemonZombies: number; fifos: number };

const samples: Sample[] = [];
const started = performance.now();
const startedWall = Date.now();
while (performance.now() - started < durationMs) {
  const pid = daemonPid(stateDir);
  const status = existsSync(`/proc/${pid}/status`) ? readFileSync(`/proc/${pid}/status`, "utf8") : "";
  // Resident memory, and its two parts: the process's own (anonymous) pages and pages of mapped files.
  const kib = (field: string): number => Math.round((Number(new RegExp(`${field}:\\s+(\\d+)\\s+kB`).exec(status)?.[1] ?? "0") * 1024) / MIB);
  const dead = zombies(pid);
  samples.push({
    atS: Math.round((performance.now() - started) / 1000),
    pausedS: Math.max(0, Math.round((Date.now() - startedWall - (performance.now() - started)) / 1000)),
    pid,
    rssMiB: kib("VmRSS"),
    anonMiB: kib("RssAnon"),
    fileMiB: kib("RssFile"),
    workingSetMiB: Math.round(workingSetBytes() / MIB),
    fds: count(`/proc/${pid}/fd`),
    threads: count(`/proc/${pid}/task`),
    zombies: dead.all,
    daemonZombies: dead.ofDaemon,
    fifos: count(join(stateDir, "stdio", "fifo")),
  });
  if (appendTo !== undefined) {
    appendFileSync(appendTo, `${JSON.stringify(samples.at(-1))}\n`);
  }
  await Bun.sleep(intervalMs);
}
console.log(JSON.stringify({ samples }));
