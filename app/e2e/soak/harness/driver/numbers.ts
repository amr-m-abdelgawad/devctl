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
  /** UTF-16 length of the stored bodies of numbered lines. */
  bodyChars: { min: number; max: number };
};

/** `rows` in storage order (one session's seq order, sessions oldest first). */
export function checkNumbers(rows: readonly StoredRow[], name: string, count: number): NumberCheck {
  const numbers: number[] = [];
  const lags: number[] = [];
  let minChars = Number.POSITIVE_INFINITY;
  let maxChars = 0;
  let done = false;
  let other = 0;
  for (const row of rows) {
    const body = typeof row.body === "string" ? row.body : "";
    const line = readFloodLine(body, name);
    if (line === "done") {
      done = true;
    } else if (line !== undefined) {
      numbers.push(line.seq);
      lags.push(Date.parse(row.timestamp ?? "") - line.writtenAt);
      minChars = Math.min(minChars, body.length);
      maxChars = Math.max(maxChars, body.length);
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
    bodyChars: { min: numbers.length > 0 ? minChars : 0, max: maxChars },
  };
}

const SEQ_HEAD = " seq=";
const TIME_HEAD = " t=";
const DONE_HEAD = " done count=";

/** A numbered flood line, the flood's done line, or neither. The name is matched literally. */
function readFloodLine(body: string, name: string): { seq: number; writtenAt: number } | "done" | undefined {
  if (!body.startsWith(name)) {
    return undefined;
  }
  const rest = body.slice(name.length);
  const numbered = readNumberedLine(rest);
  if (numbered !== undefined) {
    return numbered;
  }
  return readDoneLine(rest);
}

function readNumberedLine(rest: string): { seq: number; writtenAt: number } | undefined {
  if (!rest.startsWith(SEQ_HEAD)) {
    return undefined;
  }
  const seq = leadingDigits(rest.slice(SEQ_HEAD.length));
  if (seq === undefined || !seq.rest.startsWith(TIME_HEAD)) {
    return undefined;
  }
  const writtenAt = leadingDigits(seq.rest.slice(TIME_HEAD.length));
  if (writtenAt === undefined || !writtenAt.rest.startsWith(" ")) {
    return undefined;
  }
  return { seq: seq.value, writtenAt: writtenAt.value };
}

function readDoneLine(rest: string): "done" | undefined {
  if (!rest.startsWith(DONE_HEAD)) {
    return undefined;
  }
  return leadingDigits(rest.slice(DONE_HEAD.length)) === undefined ? undefined : "done";
}

function leadingDigits(text: string): { value: number; rest: string } | undefined {
  let index = 0;
  while (index < text.length && text.charAt(index) >= "0" && text.charAt(index) <= "9") {
    index += 1;
  }
  if (index === 0) {
    return undefined;
  }
  return { value: Number(text.slice(0, index)), rest: text.slice(index) };
}
