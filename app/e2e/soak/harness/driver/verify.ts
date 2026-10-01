// Checks that a flood's numbered lines were stored gap-free, once each and in
// order, and prints one JSON object.
//
//   bun verify.ts --session-dir <dir> --name flood --count N [--service flood]
//       every `<service>.jsonl` and `<service>~<k>.jsonl` part of one session
//   devctl logs flood --all --json | bun verify.ts --stdin --name flood --count N
//       what `devctl logs` returned
//
// Records are keyed by seq (a re-tag writes a record twice; the last copy
// wins) and read in seq order. `lagMs` is each record's stored time minus the
// write time the flood embedded in the line.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, summarizeLatencies } from "./rpc.ts";

const args = parseArgs(process.argv.slice(2));
const name = args.name ?? "flood";
const service = args.service ?? name;
const count = Number(args.count ?? "0");
const pattern = new RegExp(`^${name} seq=(\\d+) t=(\\d+) `);
const donePattern = new RegExp(`^${name} done count=(\\d+)`);

type Row = { n: number; lag: number };
const bySeq = new Map<number, Row | "done" | "other">();
let parsed = 0;
let malformed = 0;

function take(line: string): void {
  if (line.trim() === "") {
    return;
  }
  let record: { seq?: number; body?: unknown; timestamp?: string; service?: string };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    malformed += 1;
    return;
  }
  if (typeof record.seq !== "number" || record.service !== service) {
    return;
  }
  parsed += 1;
  const body = typeof record.body === "string" ? record.body : "";
  const match = pattern.exec(body);
  if (match !== null) {
    bySeq.set(record.seq, { n: Number(match[1]), lag: Date.parse(record.timestamp ?? "") - Number(match[2]) });
  } else {
    bySeq.set(record.seq, donePattern.test(body) ? "done" : "other");
  }
}

function takeText(text: string): void {
  let start = 0;
  for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n", start)) {
    take(text.slice(start, newline));
    start = newline + 1;
  }
  take(text.slice(start));
}

const files: string[] = [];
if (args.stdin === "1") {
  takeText(await new Response(Bun.stdin.stream()).text());
} else {
  const dir = args["session-dir"] ?? "";
  const safe = service.replace(/[^A-Za-z0-9._-]+/g, "_") || "service";
  for (const file of readdirSync(dir).sort()) {
    if (file === `${safe}.jsonl` || (file.startsWith(`${safe}~`) && file.endsWith(".jsonl"))) {
      files.push(file);
      takeText(readFileSync(join(dir, file), "utf8"));
    }
  }
}

const seqs = [...bySeq.keys()].sort((a, b) => a - b);
const numbers: number[] = [];
const lags: number[] = [];
let done = false;
let other = 0;
for (const seq of seqs) {
  const row = bySeq.get(seq)!;
  if (row === "done") {
    done = true;
  } else if (row === "other") {
    other += 1;
  } else {
    numbers.push(row.n);
    lags.push(row.lag);
  }
}

let outOfOrder = 0;
for (let index = 1; index < numbers.length; index += 1) {
  if (numbers[index]! <= numbers[index - 1]!) {
    outOfOrder += 1;
  }
}
const seen = new Set(numbers);
const duplicates = numbers.length - seen.size;
const first = numbers[0] ?? 0;
const last = numbers[numbers.length - 1] ?? 0;
// Numbers missing between the first and last stored one: a gap inside what was kept.
const missingInside: number[] = [];
for (let n = first; n <= last && missingInside.length < 20; n += 1) {
  if (!seen.has(n)) {
    missingInside.push(n);
  }
}
let missingInsideCount = 0;
for (let n = first; n <= last; n += 1) {
  if (!seen.has(n)) {
    missingInsideCount += 1;
  }
}

console.log(JSON.stringify({
  files,
  parsed,
  malformed,
  records: numbers.length,
  other,
  first,
  last,
  count,
  complete: count > 0 && first === 1 && last === count && missingInsideCount === 0 && duplicates === 0,
  contiguousTail: last === count && missingInsideCount === 0 && duplicates === 0,
  missingInside: missingInsideCount,
  missingSample: missingInside,
  duplicates,
  outOfOrder,
  done,
  lagMs: summarizeLatencies(lags),
}));
