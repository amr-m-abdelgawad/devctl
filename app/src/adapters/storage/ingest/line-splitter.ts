import { MAX_LOG_LINE_CHARS } from "../../../domain/logs/types.ts";
import { SPLIT_MAX_BYTES } from "../../../domain/logs/budgets.ts";

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export type SplitterOptions = {
  maxBytes?: number;
  maxChars?: number;
};

/**
 * Splits a byte stream into lines. A line longer than the byte cap is decoded
 * only up to `maxChars` UTF-16 units; the rest is skipped without being buffered.
 * A trailing CR is stripped, matching the historical pump. Every line is a
 * string of its own: none is a slice of a larger decoded string, which JSC
 * would keep alive whole for as long as the record holds the line.
 */
export class LineSplitter {
  private pending = Buffer.alloc(0);
  private skipping = false;
  private readonly maxBytes: number;
  private readonly maxChars: number;

  constructor(options: SplitterOptions = {}) {
    this.maxBytes = options.maxBytes ?? SPLIT_MAX_BYTES;
    this.maxChars = options.maxChars ?? MAX_LOG_LINE_CHARS;
  }

  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let input = Buffer.from(chunk);
    while (input.length > 0) {
      if (this.skipping) {
        const newline = input.indexOf(NEWLINE);
        if (newline < 0) {
          return lines;
        }
        input = input.subarray(newline + 1);
        this.skipping = false;
      } else {
        const newline = input.indexOf(NEWLINE);
        const piece = newline < 0 ? input : input.subarray(0, newline);
        this.pending = Buffer.concat([this.pending, piece]);
        const capped = this.pending.length >= this.maxBytes;
        if (newline < 0 && !capped) {
          return lines;
        }
        if (capped && newline < 0) {
          lines.push(decodePrefix(this.pending.subarray(0, this.maxBytes), this.maxChars));
          this.pending = Buffer.alloc(0);
          this.skipping = true;
        } else {
          lines.push(decodePrefix(withoutTrailingCR(this.pending), this.maxChars));
          this.pending = Buffer.alloc(0);
          input = newline < 0 ? Buffer.alloc(0) : input.subarray(newline + 1);
        }
      }
    }
    return lines;
  }

  finish(): string[] {
    if (this.skipping || this.pending.length === 0) {
      this.pending = Buffer.alloc(0);
      this.skipping = false;
      return [];
    }
    const line = decodePrefix(withoutTrailingCR(this.pending), this.maxChars);
    this.pending = Buffer.alloc(0);
    return [line];
  }
}

function withoutTrailingCR(buf: Buffer): Buffer {
  return buf.length > 0 && buf[buf.length - 1] === CARRIAGE_RETURN ? buf.subarray(0, buf.length - 1) : buf;
}

/** Decodes at most `maxChars` UTF-16 units from the front of `buf`, decoding only the bytes it keeps. */
export function decodePrefix(buf: Buffer, maxChars: number): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, prefixByteLength(buf, maxChars)));
  if (text.length <= maxChars) {
    return text;
  }
  // Malformed bytes decode one replacement char each and can still overrun
  // the count; a copy keeps the slice from pinning what it cut off.
  return Buffer.from(text.slice(0, maxChars), "utf8").toString("utf8");
}

// Bytes in the longest run of whole UTF-8 sequences from the front of `buf`
// that decodes to at most `maxChars` UTF-16 units. No byte decodes to more
// than one unit, so a buffer no longer than the cap is kept whole.
function prefixByteLength(buf: Buffer, maxChars: number): number {
  if (buf.length <= maxChars) {
    return buf.length;
  }
  let units = 0;
  let index = 0;
  while (index < buf.length) {
    const lead = buf[index]!;
    const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    const need = width === 4 ? 2 : 1;
    if (units + need > maxChars) {
      break;
    }
    units += need;
    index += width;
  }
  return Math.min(index, buf.length);
}
