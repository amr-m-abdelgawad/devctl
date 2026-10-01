// Samples the container's zombie processes from /proc and prints
// `{ max, last, samples, byParent }` (byParent: zombie count per parent pid
// at the last sample).
//
//   bun zombies.ts --duration-ms 20000 [--interval-ms 500]
import { readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const durationMs = Number(args["duration-ms"] ?? "20000");
const intervalMs = Number(args["interval-ms"] ?? "500");

function zombies(): Map<number, number> {
  const byParent = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // `comm` may hold spaces and parentheses; the state follows the last ')'.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") {
        const parent = Number(fields[1]);
        byParent.set(parent, (byParent.get(parent) ?? 0) + 1);
      }
    } catch {
      // exited between readdir and read
    }
  }
  return byParent;
}

const deadline = Date.now() + durationMs;
let max = 0;
let last = new Map<number, number>();
let samples = 0;
while (Date.now() < deadline) {
  last = zombies();
  const total = [...last.values()].reduce((sum, value) => sum + value, 0);
  max = Math.max(max, total);
  samples += 1;
  await Bun.sleep(intervalMs);
}
const lastTotal = [...last.values()].reduce((sum, value) => sum + value, 0);
console.log(JSON.stringify({ max, last: lastTotal, samples, byParent: Object.fromEntries(last) }));
