import { describe, expect, test } from "bun:test";
import { approxRecordBytes } from "../../domain/logs/size.ts";
import { logRecord, type LogRecord } from "../../domain/logs/logs.ts";
import { LogRing } from "./log-ring.ts";

function record(seq: number, body = `line ${seq}`, service = "api"): LogRecord {
  return logRecord({ seq, service, message: body, level: seq % 10 === 0 ? "ERROR" : "INFO" });
}

function heldSeqs(ring: LogRing): number[] {
  const seqs: number[] = [];
  ring.forEach((event) => seqs.push(event.seq));
  return seqs;
}

function heldBytes(ring: LogRing): number {
  let total = 0;
  ring.forEach((event) => {
    total += approxRecordBytes(event);
  });
  return total;
}

describe("log ring", () => {
  test("evicts by count when there is no byte budget", () => {
    const ring = new LogRing(3, 0);
    for (let seq = 1; seq <= 5; seq += 1) {
      ring.push(record(seq));
    }
    expect(heldSeqs(ring)).toEqual([3, 4, 5]);
    expect(ring.oldestSeq()).toBe(3);
    expect(ring.counts).toEqual({ api: 3 });
  });

  test("evicts the oldest records by bytes but always keeps the newest", () => {
    const one = approxRecordBytes(record(1, "x".repeat(100)));
    const ring = new LogRing(1_000, one * 3);
    for (let seq = 1; seq <= 10; seq += 1) {
      ring.push(record(seq, "x".repeat(100)));
    }
    expect(heldSeqs(ring)).toEqual([8, 9, 10]);
    expect(ring.byteSize()).toBe(heldBytes(ring));
    expect(ring.push(record(11, "y".repeat(10_000)))).toBe(3);
    expect(heldSeqs(ring)).toEqual([11]);
    expect(ring.byteSize()).toBe(heldBytes(ring));
  });

  test("a smaller budget evicts at once and reports how many left", () => {
    const one = approxRecordBytes(record(1, "x".repeat(100)));
    const ring = new LogRing(1_000, 0);
    for (let seq = 1; seq <= 10; seq += 1) {
      ring.push(record(seq, "x".repeat(100)));
    }
    expect(ring.setMaxBytes(one * 4)).toBe(6);
    expect(heldSeqs(ring)).toEqual([7, 8, 9, 10]);
  });

  test("byte accounting does not drift across replacements, compaction, and eviction", () => {
    const ring = new LogRing(100_000, 400_000);
    for (let seq = 1; seq <= 20_000; seq += 1) {
      ring.push(record(seq, `line ${seq} ${"z".repeat(seq % 300)}`, seq % 3 === 0 ? "worker" : "api"));
      if (seq % 7 === 0) {
        const target = seq - 3;
        const updated = { ...record(target, `retagged ${target} ${"w".repeat(target % 500)}`), attributes: { "http.request_id": `r${target}` } };
        ring.replace(target, updated);
      }
    }
    expect(ring.byteSize()).toBe(heldBytes(ring));
    expect(ring.byteSize()).toBeLessThanOrEqual(400_000);
    const seqs = heldSeqs(ring);
    expect(seqs[seqs.length - 1]).toBe(20_000);
    expect(seqs.every((seq, i) => i === 0 || seq === seqs[i - 1]! + 1)).toBe(true);
    let api = 0;
    let errors = 0;
    ring.forEach((event) => {
      api += event.service === "api" ? 1 : 0;
      errors += event.severityText === "ERROR" ? 1 : 0;
    });
    expect(ring.counts.api).toBe(api);
    expect(ring.errors).toBe(errors);
  });

  test("seq lookups are binary searches that survive compaction", () => {
    const ring = new LogRing(5_000, 0);
    for (let seq = 1; seq <= 12_000; seq += 2) {
      ring.push(record(seq));
    }
    expect(ring.length).toBe(5_000);
    const oldest = ring.oldestSeq()!;
    expect(ring.at(0)?.seq).toBe(oldest);
    expect(ring.at(ring.length - 1)?.seq).toBe(11_999);
    expect(ring.at(ring.length)).toBeUndefined();
    expect(ring.at(-1)).toBeUndefined();
    expect(ring.lowerBound(0)).toBe(0);
    expect(ring.lowerBound(oldest + 1)).toBe(1);
    expect(ring.lowerBound(oldest + 2)).toBe(1);
    expect(ring.lowerBound(20_000)).toBe(ring.length);
    expect(ring.replace(oldest + 1, record(oldest + 1))).toBe(false);
    expect(ring.replace(oldest - 2, record(oldest - 2))).toBe(false);
    const updated = record(oldest + 2, "replaced");
    expect(ring.replace(oldest + 2, updated)).toBe(true);
    expect(ring.at(1)).toBe(updated);
  });

  test("eviction under a binding byte budget stays O(1) per push", () => {
    // The old ring copied every held record on each push once over budget:
    // about 130 us a push at 40,000 records, so 20,000 pushes took seconds.
    const body = "y".repeat(1_000);
    const size = approxRecordBytes(record(1, `1 ${body}`));
    const ring = new LogRing(10_000_000, size * 40_000);
    const records = Array.from({ length: 60_000 }, (_, i) => record(i + 1, `${i + 1} ${body}`));
    for (let i = 0; i < 40_000; i += 1) {
      ring.push(records[i]!);
    }
    const started = performance.now();
    for (let i = 40_000; i < 60_000; i += 1) {
      ring.push(records[i]!);
    }
    const elapsed = performance.now() - started;
    expect(ring.length).toBeGreaterThan(39_000);
    expect(ring.oldestSeq()).toBeGreaterThan(20_000);
    expect(elapsed).toBeLessThan(1_000);
  });
});
