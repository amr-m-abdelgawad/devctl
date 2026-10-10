// A service that holds `<count>` open file descriptors and idles, so every
// /proc/<pid>/fd scan of it reads that many links.
//
//   bun fdhog.ts 5000
import { openSync } from "node:fs";

const count = Number(process.argv[2] ?? "5000");
const fds: number[] = [];
for (let index = 0; index < count; index += 1) {
  fds.push(openSync("/dev/null", "r"));
}
console.log(`fdhog holding ${fds.length} fds`);
setInterval(() => undefined, 1 << 30);
