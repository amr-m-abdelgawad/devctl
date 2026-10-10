// Prints one service's persisted records from a session directory, in seq
// order, as `{ records: [{ seq, body, timestamp }], manifest }`.
//
//   bun records.ts --session-dir <dir> --service api
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const dir = args["session-dir"] ?? "";
const service = args.service ?? "api";
const safe = service.replace(/[^A-Za-z0-9._-]+/g, "_") || "service";
const bySeq = new Map<number, { seq: number; body: unknown; timestamp: string }>();
for (const file of existsSync(dir) ? readdirSync(dir) : []) {
  if (file !== `${safe}.jsonl` && !(file.startsWith(`${safe}~`) && file.endsWith(".jsonl"))) {
    continue;
  }
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const record = JSON.parse(line) as { seq: number; body: unknown; timestamp: string };
    bySeq.set(record.seq, { seq: record.seq, body: record.body, timestamp: record.timestamp });
  }
}
const manifestPath = join(dir, "manifest.json");
console.log(JSON.stringify({
  exists: existsSync(dir),
  records: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
  manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as unknown : undefined,
}));
