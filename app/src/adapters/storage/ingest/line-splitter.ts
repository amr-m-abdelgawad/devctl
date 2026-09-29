import { MAX_LOG_LINE_CHARS } from "../../../domain/logs/types.ts";
import { SPLIT_MAX_BYTES } from "../../../domain/logs/budgets.ts";

const NEWLINE = 0x0a;

export type SplitterOptions = {
  maxBytes?: number;
  maxChars?: number;
};

/**
 * Splits a byte stream into lines. A line longer than the byte cap is decoded
 * only up to `maxChars` UTF-16 units; the rest is skipped without being buffered.
 * A trailing CR is stripped, matching the historical pump.
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
          lines.push(decodePrefix(this.pending, this.maxChars).replace(/\r$/, ""));
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
    const line = decodePrefix(this.pending, this.maxChars).replace(/\r$/, "");
    this.pending = Buffer.alloc(0);
    return [line];
  }
}

export function decodePrefix(buf: Buffer, maxChars: number): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}
