import { describe, expect, test } from "bun:test";
import { LogBatcher, type LogBatchPayload } from "./batch.ts";
import { logRecord } from "./record.ts";

const emptyStats = { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 };

describe("live log batches", () => {
  test("a batch carries at most the newest 500 records and counts the rest", () => {
    const published: LogBatchPayload[] = [];
    const batcher = new LogBatcher("s", () => emptyStats, (batch) => {
      published.push(batch);
    });
    for (let seq = 1; seq <= 2_000; seq += 1) {
      batcher.push(logRecord({ seq, service: "api", message: `m${seq}` }));
    }
    batcher.flush();
    expect(published).toHaveLength(1);
    const batch = published[0]!;
    expect(batch.newest).toHaveLength(500);
    expect(batch.newest[0]?.seq).toBe(1_501);
    expect(batch.firstSeq).toBe(1);
    expect(batch.lastSeq).toBe(2_000);
    expect(batch.skipped).toBe(1_500);
  });
});
