import { describe, expect, test } from "bun:test";
import { fullGC, heapStats, isRope } from "bun:jsc";
import { MAX_LOG_LINE_CHARS } from "../../../domain/logs/types.ts";
import { decodePrefix, LineSplitter } from "./line-splitter.ts";

const KIB = 1024;

// Bytes a batch of lines keeps alive once everything else is collected. The
// work is synchronous, so nothing else allocates between the two readings.
function retainedPerLine(make: (index: number) => string, count: number): number {
  const kept: string[] = [];
  fullGC();
  const before = heapStats().extraMemorySize;
  for (let index = 0; index < count; index += 1) {
    kept.push(make(index));
  }
  fullGC();
  const after = heapStats().extraMemorySize;
  expect(kept).toHaveLength(count);
  return (after - before) / count;
}

function asciiLine(index: number, bytes: number, newline: boolean): Buffer {
  const buf = Buffer.alloc(bytes, 0x61 + (index % 26));
  if (newline) {
    buf[bytes - 1] = 0x0a;
  }
  return buf;
}

describe("line splitter retention", () => {
  test("a long line keeps only the kept prefix alive, on every path out", () => {
    // 40 KiB lines are under the 48 KiB byte cap but past the 16 KiB char cap.
    // Slicing a whole-line decode kept all 40 KiB alive behind each 16 KiB line.
    const complete = retainedPerLine((index) => new LineSplitter().push(asciiLine(index, 40 * KIB, true))[0]!, 200);
    const unterminated = retainedPerLine((index) => {
      const splitter = new LineSplitter();
      expect(splitter.push(asciiLine(index, 40 * KIB, false))).toEqual([]);
      return splitter.finish()[0]!;
    }, 200);
    const capped = retainedPerLine((index) => new LineSplitter().push(asciiLine(index, 64 * KIB, false))[0]!, 200);
    for (const perLine of [complete, unterminated, capped]) {
      expect(perLine).toBeGreaterThanOrEqual(MAX_LOG_LINE_CHARS - KIB);
      expect(perLine).toBeLessThan(MAX_LOG_LINE_CHARS + 8 * KIB);
    }
  });

  test("a line cut at the byte cap is its own string, not a view of a larger one", () => {
    const line = new LineSplitter().push(asciiLine(0, 64 * KIB, false))[0]!;
    expect(line).toHaveLength(MAX_LOG_LINE_CHARS);
    expect(isRope(line)).toBe(false);
  });

  test("the prefix never splits a UTF-8 sequence or a surrogate pair", () => {
    expect(decodePrefix(Buffer.from("你好世界"), 3)).toBe("你好世");
    expect(decodePrefix(Buffer.from("a😀b"), 2)).toBe("a");
    expect(decodePrefix(Buffer.from("a😀b"), 3)).toBe("a😀");
    expect(decodePrefix(Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x63]), 4)).toHaveLength(4);
    expect(new LineSplitter({ maxChars: 4 }).push(Buffer.from("abc\r\n"))).toEqual(["abc"]);
    expect(new LineSplitter({ maxChars: 2 }).push(Buffer.from("abc\r\n"))).toEqual(["ab"]);
  });
});
