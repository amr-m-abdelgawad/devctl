import { describe, expect, test } from "bun:test";
import { logRecord, type LogRecord } from "../../domain/logs/logs.ts";
import { indexedSource, pageSource, seqIndexed, stackedSource, type SeqSource } from "./log-page.ts";

function records(from: number, to: number): LogRecord[] {
  const out: LogRecord[] = [];
  for (let seq = from; seq <= to; seq += 1) {
    out.push(logRecord({ seq, service: seq % 2 === 0 ? "api" : "worker", message: `line ${seq}` }));
  }
  return out;
}

function counted(match: (event: LogRecord) => boolean = () => true): { calls: () => number; matches: (event: LogRecord) => boolean } {
  let calls = 0;
  return {
    calls: () => calls,
    matches: (event) => {
      calls += 1;
      return match(event);
    },
  };
}

function seqs(events: readonly LogRecord[]): number[] {
  return events.map((event) => event.seq);
}

describe("paging a seq source", () => {
  const all = records(1, 50_000);

  test("the newest page reads one match past the page, not the whole window", () => {
    const probe = counted();
    const page = pageSource(indexedSource(seqIndexed(all), probe.matches), { direction: "backward", limit: 500 });
    expect(page.events[0]?.seq).toBe(49_501);
    expect(page.events[499]?.seq).toBe(50_000);
    expect(page.hasPrev).toBe(true);
    expect(page.hasNext).toBe(false);
    expect(probe.calls()).toBe(501);
  });

  test("a cursor page seeks by seq and checks only its neighbours for the flags", () => {
    const probe = counted();
    const back = pageSource(indexedSource(seqIndexed(all), probe.matches), { cursor: 20_000, direction: "backward", limit: 100 });
    expect(seqs(back.events)).toEqual(seqs(all.slice(19_899, 19_999)));
    expect(back.hasPrev && back.hasNext).toBe(true);
    expect(probe.calls()).toBe(102);
    const forward = counted();
    const head = pageSource(indexedSource(seqIndexed(all), forward.matches), { cursor: 49_990, direction: "forward", limit: 500 });
    expect(seqs(head.events)).toEqual(seqs(all.slice(49_990)));
    expect(head.hasNext).toBe(false);
    expect(head.hasPrev).toBe(true);
    expect(forward.calls()).toBe(11);
  });

  test("filters apply before the page is cut, and flags see matches past it", () => {
    const api = (event: LogRecord): boolean => event.service === "api";
    const source = indexedSource(seqIndexed(records(1, 10)), api);
    const newest = pageSource(source, { direction: "backward", limit: 2 });
    expect(seqs(newest.events)).toEqual([8, 10]);
    expect(newest.hasPrev).toBe(true);
    const older = pageSource(source, { cursor: 8, direction: "backward", limit: 10 });
    expect(seqs(older.events)).toEqual([2, 4, 6]);
    expect(older.hasPrev).toBe(false);
    expect(older.hasNext).toBe(true);
    const empty = pageSource(source, { cursor: 10, direction: "forward", limit: 10 });
    expect(empty.events).toEqual([]);
    expect(empty.hasPrev || empty.hasNext).toBe(false);
  });

  test("a stacked source walks the older part only below the boundary", () => {
    const olderCalls = { down: 0, up: 0 };
    const olderRecords = indexedSource(seqIndexed(records(1, 99)), () => true);
    const older: SeqSource = {
      walkDown: (before, visit) => {
        olderCalls.down += 1;
        return olderRecords.walkDown(before, visit);
      },
      walkUp: (from, visit) => {
        olderCalls.up += 1;
        return olderRecords.walkUp(from, visit);
      },
    };
    const ring = indexedSource(seqIndexed(records(100, 200)), () => true);
    const stacked = stackedSource(ring, 100, older);
    const head = pageSource(stacked, { cursor: 150, direction: "forward", limit: 10 }, (first) => (first >= 100 ? ring : stacked));
    expect(seqs(head.events)).toEqual(seqs(records(151, 160)));
    expect(olderCalls).toEqual({ down: 0, up: 0 });
    const across = pageSource(stacked, { cursor: 105, direction: "backward", limit: 10 });
    expect(seqs(across.events)).toEqual(seqs(records(95, 104)));
    expect(olderCalls.down).toBe(1);
    const fromOld = pageSource(stacked, { cursor: 94, direction: "forward", limit: 10 });
    expect(seqs(fromOld.events)).toEqual(seqs(records(95, 104)));
    expect(fromOld.hasPrev && fromOld.hasNext).toBe(true);
  });

  test("a walk cut short by its budget reports where to resume", () => {
    const partial: SeqSource = {
      walkDown: (_before, visit) => {
        visit(records(40, 40)[0]!);
        return { truncated: true, frontier: 30 };
      },
      walkUp: () => ({ truncated: true, frontier: 60 }),
    };
    const page = pageSource(partial, { cursor: 50, direction: "backward", limit: 10 });
    expect(seqs(page.events)).toEqual([40]);
    expect(page.hasPrev).toBe(true);
    expect(page.prevFrontier).toBe(30);
    const forward = pageSource(partial, { cursor: 50, direction: "forward", limit: 10 });
    expect(forward.events).toEqual([]);
    expect(forward.hasNext).toBe(true);
    expect(forward.nextFrontier).toBe(60);
  });
});
