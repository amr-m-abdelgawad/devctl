// The gap-free check shared by verify.ts and page.ts: a flood's numbered
// lines, read in storage order, must hold each number once and in order.
import { summarizeLatencies } from "./rpc.ts";

export type StoredRow = { seq: number; body: unknown; timestamp?: string };

export type NumberCheck = {
  records: number;
  other: number;
  first: number;
  last: number;
  count: number;
  /** Every number 1..count, once each. */
  complete: boolean;
  /** Ends at count with nothing missing or repeated inside what was kept. */
  contiguousTail: boolean;
  missingInside: number;
  missingSample: number[];
  duplicates: number;
  outOfOrder: number;
  done: boolean;
  /** Stored time minus the write time the flood embedded in each line. */
  lagMs: { count: number; p50: number; p99: number; max: number };
};

/** `rows` in storage order (one session's seq order, sessions oldest first). */
export function checkNumbers(rows: readonly StoredRow[], name: string, count: number): NumberCheck {
  const pattern = new RegExp(`^${name} seq=(\\d+) t=(\\d+) `);
  const donePattern = new RegExp(`^${name} done count=(\\d+)`);
  const numbers: number[] = [];
  const lags: number[] = [];
  let done = false;
  let other = 0;
  for (const row of rows) {
    const body = typeof row.body === "string" ? row.body : "";
    const match = pattern.exec(body);
    if (match !== null) {
      numbers.push(Number(match[1]));
      lags.push(Date.parse(row.timestamp ?? "") - Number(match[2]));
    } else if (donePattern.test(body)) {
      done = true;
    } else {
      other += 1;
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
  let first = numbers.length > 0 ? Number.POSITIVE_INFINITY : 0;
  let last = 0;
  for (const n of numbers) {
    first = Math.min(first, n);
    last = Math.max(last, n);
  }
  const missingSample: number[] = [];
  let missingInside = 0;
  for (let n = first; n <= last; n += 1) {
    if (!seen.has(n)) {
      missingInside += 1;
      if (missingSample.length < 20) {
        missingSample.push(n);
      }
    }
  }
  return {
    records: numbers.length,
    other,
    first,
    last,
    count,
    complete: count > 0 && first === 1 && last === count && missingInside === 0 && duplicates === 0,
    contiguousTail: last === count && missingInside === 0 && duplicates === 0,
    missingInside,
    missingSample,
    duplicates,
    outOfOrder,
    done,
    lagMs: summarizeLatencies(lags),
  };
}
