// Checks that a flood's numbered lines were stored gap-free, once each and in
// order, and prints one JSON object (see numbers.ts).
//
//   bun verify.ts --session-dir <dir>[,<dir>…] --name flood --count N [--service flood]
//       every `<service>.jsonl` and `<service>~<k>.jsonl` part of the given
//       sessions, oldest session first
//   devctl logs flood --all --json | bun verify.ts --stdin --name flood --count N
//       what `devctl logs` returned
//
// Within a session records are keyed by seq (a re-tag writes a record twice;
// the last copy wins) and read in seq order.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkNumbers, type StoredRow } from "./numbers.ts";
import { parseArgs } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const name = args.name ?? "flood";
const service = args.service ?? name;
const count = Number(args.count ?? "0");

let malformed = 0;

function collect(text: string, bySeq: Map<number, StoredRow>): void {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) {
      end = text.length;
    }
    const line = text.slice(start, end);
    start = end + 1;
    if (line.trim() === "") {
      continue;
    }
    try {
      const record = JSON.parse(line) as { seq?: number; body?: unknown; timestamp?: string; service?: string };
      if (typeof record.seq === "number" && record.service === service) {
        bySeq.set(record.seq, { seq: record.seq, body: record.body, timestamp: record.timestamp });
      }
    } catch {
      malformed += 1;
    }
  }
}

function inSeqOrder(bySeq: Map<number, StoredRow>): StoredRow[] {
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const files: string[] = [];
const rows: StoredRow[] = [];
if (args.stdin === "1") {
  const bySeq = new Map<number, StoredRow>();
  collect(await new Response(Bun.stdin.stream()).text(), bySeq);
  rows.push(...inSeqOrder(bySeq));
} else {
  const safe = service.replace(/[^A-Za-z0-9._-]+/g, "_") || "service";
  for (const dir of (args["session-dir"] ?? "").split(",").filter((entry) => entry !== "")) {
    const bySeq = new Map<number, StoredRow>();
    for (const file of readdirSync(dir).sort()) {
      if (file === `${safe}.jsonl` || (file.startsWith(`${safe}~`) && file.endsWith(".jsonl"))) {
        files.push(join(dir, file));
        collect(readFileSync(join(dir, file), "utf8"), bySeq);
      }
    }
    rows.push(...inSeqOrder(bySeq));
  }
}

console.log(JSON.stringify({ files, malformed, ...checkNumbers(rows, name, count) }));
