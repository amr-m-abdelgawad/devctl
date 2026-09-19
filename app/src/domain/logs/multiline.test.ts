import { describe, expect, test } from "bun:test";
import { MultilineAssembler } from "./multiline.ts";
import { SeverityError, SeverityInfo, SeverityUnspecified } from "./severity.ts";

function ingest(message: string, service = "api", source = "stdout") {
  return { service, source, stream: source, pid: 1, message };
}

function pythonTraceback(frames = 28): string[] {
  const lines = ["Traceback (most recent call last):"];
  for (let i = 0; i < frames; i += 1) {
    lines.push(`  File "app.py", line ${i + 1}, in frame_${i}`);
    lines.push(`    call_${i}()`);
  }
  lines.push("ValueError: boom");
  return lines;
}

describe("MultilineAssembler", () => {
  test("folds a ~30-line Python traceback into one event", () => {
    const assembler = new MultilineAssembler();
    const lines = pythonTraceback(14);
    expect(lines.length).toBeGreaterThanOrEqual(30);
    const emitted: string[] = [];
    let now = 1_000;
    for (const line of lines) {
      emitted.push(...assembler.push(ingest(line), now).map((item) => item.body));
      now += 1;
    }
    expect(emitted).toEqual([]);
    const folded = assembler.flushAll();
    expect(folded).toHaveLength(1);
    expect(folded[0]?.body.split("\n")).toHaveLength(lines.length);
    expect(folded[0]?.body.startsWith("Traceback (most recent call last):")).toBe(true);
    expect(folded[0]?.body.endsWith("ValueError: boom")).toBe(true);
  });

  test("folds a bare HTTP status into the previous INFO access line", () => {
    const assembler = new MultilineAssembler();
    expect(assembler.push(ingest("INFO GET /api/health"), 1_000)).toEqual([]);
    expect(assembler.push(ingest("             200"), 1_010)).toEqual([]);
    const folded = assembler.flushAll();
    expect(folded).toHaveLength(1);
    expect(folded[0]?.body).toBe("INFO GET /api/health\n             200");
    expect(folded[0]?.severityNumber).toBe(SeverityInfo);
  });

  test("opt-in start/continuation regex plus max_lines", () => {
    const assembler = new MultilineAssembler();
    const opts = { start: "^\\d{4}-\\d{2}-\\d{2}", continuation: "^\\s+", max_lines: 2 };
    expect(assembler.push(ingest("2026-09-19 first"), 1_000, opts)).toEqual([]);
    const overflow = assembler.push(ingest("  continued"), 1_010, opts);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.body).toBe("2026-09-19 first\n  continued");
    expect(assembler.push(ingest("  leftover"), 1_020, opts)).toEqual([]);
    const next = assembler.push(ingest("2026-09-19 second"), 1_030, opts);
    expect(next).toHaveLength(1);
    expect(next[0]?.body).toBe("  leftover");
    expect(assembler.flushAll()[0]?.body).toBe("2026-09-19 second");
  });

  test("idle timeout emits the pending buffer", () => {
    const assembler = new MultilineAssembler();
    const opts = { max_wait_ms: 80 };
    expect(assembler.push(ingest("still open"), 1_000, opts)).toEqual([]);
    expect(assembler.flushDue(1_079)).toEqual([]);
    const due = assembler.flushDue(1_080);
    expect(due).toHaveLength(1);
    expect(due[0]?.body).toBe("still open");
    expect(due[0]?.arrivedMs).toBe(1_000);
  });

  test("keeps the first line's arrival time across continuations", () => {
    const assembler = new MultilineAssembler();
    expect(assembler.push(ingest("INFO GET /api/health"), 1_000)).toEqual([]);
    expect(assembler.push(ingest("             200"), 1_040)).toEqual([]);
    const folded = assembler.flushAll();
    expect(folded[0]?.arrivedMs).toBe(1_000);
  });

  test("severity comes from the first classifying line after ANSI strip", () => {
    const assembler = new MultilineAssembler();
    assembler.push(ingest("\x1b[31mERROR\x1b[0m request failed"), 1_000);
    assembler.push(ingest("  detail without a level"), 1_001, { continuation: "^\\s+" });
    const folded = assembler.flushAll();
    expect(folded[0]?.severityNumber).toBe(SeverityError);
    expect(folded[0]?.body.startsWith("ERROR request failed")).toBe(true);
  });

  test("stdout and stderr of the same service do not share a buffer", () => {
    const assembler = new MultilineAssembler();
    expect(assembler.push(ingest("Traceback (most recent call last):"), 1_000)).toEqual([]);
    expect(assembler.push(ingest("unrelated stderr line", "api", "stderr"), 1_001)).toEqual([]);
    const folded = assembler.flushAll();
    expect(folded).toHaveLength(2);
    expect(folded.map((item) => item.body)).toEqual(["Traceback (most recent call last):", "unrelated stderr line"]);
  });

  test("unknown text stays unspecified until a later line classifies", () => {
    const assembler = new MultilineAssembler();
    assembler.push(ingest("Traceback (most recent call last):"), 1_000);
    assembler.push(ingest("  File \"app.py\", line 1, in <module>"), 1_001);
    assembler.push(ingest("    boom()"), 1_002);
    assembler.push(ingest("RuntimeError: failed"), 1_003);
    const folded = assembler.flushAll();
    expect(folded[0]?.severityNumber).toBe(SeverityUnspecified);
  });
});
