// Drives one timed fixture through the pre-branch oracle and through the
// current ingest path on the same fake clock, and compares what each stored.
//
// The oracle is main's pump and LogManager.append (test/oracle/pre-branch):
// every read is split at once and appended with the clock at that moment, as
// the orchestrator's onLine did. The current side is LogManager.acceptChunk +
// IngestPipeline with `readAtMs` set to the same moment; its 8 ms drain and
// the fold flush run as fake timers, so both sides see the same timeline and
// nothing depends on how loaded the machine is. The pipeline's spool reads
// and writes are real file I/O, so the clock is stepped a millisecond at a
// time and each step waits for that I/O to land.
import { jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLogParser, LogManager, type LogIngest, type LogRecord } from "../../src/adapters/storage/logs.ts";
import type { IngestPipeline, PipelineLimits } from "../../src/adapters/storage/ingest/pipeline.ts";
import type { ServiceLogConfig } from "../../src/domain/config/types.ts";
import { defaultLogParser as preBranchDefaultParser } from "./pre-branch/domain/logs/parse.ts";
import { PreBranchLogManager } from "./pre-branch/log-manager.oracle.ts";
import { PreBranchLinePump } from "./pre-branch/pump.oracle.ts";

/** Fixture times are milliseconds after this instant. */
export const FIXTURE_EPOCH_MS = Date.parse("2026-09-28T12:00:00.000Z");

// Past the 80 ms fold wait, the 50 ms correlate window, and the 8 ms drain.
const SETTLE_MS = 1_000;
// How long after the last read a backlogged run starts parsing.
const BACKLOG_HOLD_MS = 500;
const RING_EVENTS = 100_000;
const MAX_OFFER_RETRIES = 1_000;

export type StreamRef = { service: string; stream: "stdout" | "stderr"; pid: number };

export type FixtureEvent =
  | { at: number; chunk: StreamRef & { bytes: string | Uint8Array } }
  | { at: number; end: StreamRef }
  | { at: number; append: Omit<LogIngest, "timestamp"> };

/**
 * A difference between main and this branch that is meant. `lane` is
 * `service/source[/stream]`, `index` the record's position in that lane, and
 * `oracle` / `current` the `summarize()` of the field on each side.
 */
export type IntendedDifference = {
  lane: string;
  index: number;
  field: string;
  oracle: string;
  current: string;
  reason: string;
};

export type IngestFixture = {
  name: string;
  covers: string;
  logs?: Record<string, ServiceLogConfig>;
  events: FixtureEvent[];
  intended?: IntendedDifference[];
};

/** How the current side gets its bytes parsed. */
export type CurrentVariant =
  /** Default pipeline limits: nothing spools. */
  | "live"
  /** One-byte spill thresholds: every chunk goes through the on-disk spool, which is read back at once. */
  | "spooled"
  /** Spooled, and no spool write lands until well after the last read, so everything is parsed late. */
  | "backlog";

export type Diff = {
  lane: string;
  index: number;
  field: string;
  oracle: string;
  current: string;
};

const TINY_SPILL: PipelineLimits = {
  spillPerStream: 1,
  spillTotal: 1,
  creditPerStream: 64 * 1024 * 1024,
  creditTotal: 256 * 1024 * 1024,
  spoolMaxBytes: 1024 * 1024 * 1024,
};

function bytesOf(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function ordered(events: readonly FixtureEvent[]): FixtureEvent[] {
  return events.map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.at - b.event.at || a.index - b.index)
    .map((row) => row.event);
}

function lastAt(events: readonly FixtureEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.at), 0);
}

function advanceTo(at: number): void {
  const delta = FIXTURE_EPOCH_MS + at - Date.now();
  if (delta > 0) {
    jest.advanceTimersByTime(delta);
  }
}

function streamKey(ref: StreamRef): string {
  return `${ref.service}\0${ref.stream}\0${ref.pid}`;
}

// main's orchestrator: `s.logs.append({ timestamp: clock.isoNow(), service, source: stream, stream, level: "", message: line, pid: handle.pid })`.
function preBranchLine(ref: StreamRef, line: string): LogIngest {
  return { timestamp: new Date().toISOString(), service: ref.service, source: ref.stream, stream: ref.stream, level: "", message: line, pid: ref.pid };
}

/** main's line source and append path. */
export function runOracle(fixture: IngestFixture): LogRecord[] {
  jest.useFakeTimers({ now: FIXTURE_EPOCH_MS });
  try {
    const mgr = new PreBranchLogManager(RING_EVENTS);
    mgr.setParsers([preBranchDefaultParser()]);
    mgr.setServiceLogs(fixture.logs ?? {});
    const pumps = new Map<string, PreBranchLinePump>();
    const pumpFor = (ref: StreamRef): PreBranchLinePump => {
      let pump = pumps.get(streamKey(ref));
      if (pump === undefined) {
        pump = new PreBranchLinePump();
        pumps.set(streamKey(ref), pump);
      }
      return pump;
    };
    for (const event of ordered(fixture.events)) {
      advanceTo(event.at);
      if ("chunk" in event) {
        for (const line of pumpFor(event.chunk).push(bytesOf(event.chunk.bytes))) {
          mgr.append(preBranchLine(event.chunk, line));
        }
      } else if ("end" in event) {
        for (const line of pumpFor(event.end).end()) {
          mgr.append(preBranchLine(event.end, line));
        }
      } else {
        mgr.append({ ...event.append, timestamp: new Date().toISOString() });
      }
    }
    advanceTo(lastAt(fixture.events) + SETTLE_MS);
    return mgr.records() as LogRecord[];
  } finally {
    jest.useRealTimers();
  }
}

function offer(mgr: LogManager, chunk: Parameters<LogManager["acceptChunk"]>[0]): void {
  for (let attempt = 0; attempt < MAX_OFFER_RETRIES; attempt += 1) {
    if (mgr.acceptChunk(chunk)) {
      return;
    }
    // A refused chunk is offered again once the pipeline drained, as the pump does.
    jest.advanceTimersByTime(1);
  }
  throw new Error(`pipeline refused a ${chunk.bytes.byteLength}-byte chunk ${MAX_OFFER_RETRIES} times`);
}

// The manager's pipeline, once the first chunk has built it. Read only to
// wait for its spool I/O; a run that cannot reach it fails the spool check.
function pipelineOf(mgr: LogManager): IngestPipeline | undefined {
  return (mgr as unknown as { pipeline?: IngestPipeline }).pipeline;
}

/** This branch: LogManager.acceptChunk through its IngestPipeline. */
export async function runCurrent(fixture: IngestFixture, variant: CurrentVariant): Promise<LogRecord[]> {
  const dir = mkdtempSync(join(tmpdir(), "devctl-oracle-"));
  jest.useFakeTimers({ now: FIXTURE_EPOCH_MS });
  try {
    const mgr = new LogManager(RING_EVENTS, undefined, undefined, false, dir, "oracle", 0, 0, {
      spoolDir: join(dir, "spool"),
      ...(variant === "live" ? {} : { pipelineLimits: TINY_SPILL }),
    });
    mgr.setParsers([defaultLogParser()]);
    mgr.setServiceLogs(fixture.logs ?? {});
    const end = lastAt(fixture.events);
    const landed = async (): Promise<void> => {
      await pipelineOf(mgr)?.settle();
    };
    // Steps the clock so spool I/O lands as it would on a daemon that keeps up.
    const stepTo = async (at: number): Promise<void> => {
      while (Date.now() < FIXTURE_EPOCH_MS + at) {
        await landed();
        jest.advanceTimersByTime(1);
      }
      await landed();
    };
    // Guards the spill thresholds: a spooled run that stops spooling is a second live run.
    const requireSpooled = (): void => {
      if ((mgr.pipelineStats()?.spooledBytes ?? 0) <= 0) {
        throw new Error(`the ${variant} run did not spool its first chunk`);
      }
    };
    // Guards the backlog: service output parsed before the hold ended was not parsed late.
    const releaseAt = FIXTURE_EPOCH_MS + end + BACKLOG_HOLD_MS;
    let early = 0;
    if (variant === "backlog") {
      mgr.setOnRecord((record) => {
        if ((record.source === "stdout" || record.source === "stderr") && Date.now() < releaseAt) {
          early += 1;
        }
      });
    }
    let spoolChecked = variant !== "spooled";
    for (const event of ordered(fixture.events)) {
      if (variant === "backlog") {
        // No await between reads, so no spool write lands and nothing read is parsed yet.
        advanceTo(event.at);
      } else {
        await stepTo(event.at);
      }
      if ("chunk" in event) {
        const { bytes, ...ref } = event.chunk;
        offer(mgr, { ...ref, readAtMs: Date.now(), bytes: bytesOf(bytes) });
        if (!spoolChecked) {
          await landed();
          requireSpooled();
          spoolChecked = true;
        }
      } else if ("end" in event) {
        offer(mgr, { ...event.end, readAtMs: Date.now(), bytes: new Uint8Array(0), end: true });
      } else {
        mgr.append({ ...event.append, timestamp: new Date().toISOString() });
      }
    }
    if (variant === "backlog") {
      advanceTo(end + BACKLOG_HOLD_MS);
      await landed();
      if (fixture.events.some((event) => "chunk" in event)) {
        requireSpooled();
      }
    }
    await stepTo(end + (variant === "backlog" ? BACKLOG_HOLD_MS : 0) + SETTLE_MS);
    await mgr.flush();
    const records = mgr.query({});
    await mgr.close();
    if (early > 0) {
      throw new Error(`the backlog run parsed ${early} records before its hold ended`);
    }
    return records;
  } finally {
    jest.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function laneOf(record: Pick<LogRecord, "service" | "source" | "stream">): string {
  return record.stream === undefined || record.stream === "" ? `${record.service}/${record.source}` : `${record.service}/${record.source}/${record.stream}`;
}

function relativeMs(ms: number): string {
  return `t+${ms - FIXTURE_EPOCH_MS}`;
}

// Epoch nanoseconds are past 2^53, so a float nanosecond count is only exact
// to about a quarter microsecond. Both sides derive it from the same
// millisecond timestamp, so compare it at millisecond precision.
function nanosAsMs(nanos: number): number {
  return Math.round(nanos / 1_000_000);
}

/** A record as compared: no `seq` (cross-lane order is not an invariant), times relative to the fixture. */
export function normalize(record: LogRecord): Record<string, unknown> {
  const { seq: _seq, ...rest } = JSON.parse(JSON.stringify(record)) as LogRecord;
  const out: Record<string, unknown> = { ...rest };
  out.timestamp = relativeMs(Date.parse(record.timestamp));
  out.timeUnixNano = relativeMs(nanosAsMs(record.timeUnixNano));
  return out;
}

/** Short, stable text for a compared value. */
export function summarize(value: unknown): string {
  if (value === undefined) {
    return "<absent>";
  }
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  if (text.length <= 96) {
    return text;
  }
  return `<${text.length} chars ${text.slice(0, 24)}…${text.slice(-24)}>`;
}

function byLane(records: readonly LogRecord[]): Map<string, Record<string, unknown>[]> {
  const lanes = new Map<string, Record<string, unknown>[]>();
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    const lane = laneOf(record);
    const rows = lanes.get(lane) ?? [];
    rows.push(normalize(record));
    lanes.set(lane, rows);
  }
  return lanes;
}

function recordSummary(row: Record<string, unknown> | undefined): string {
  return row === undefined ? "<absent>" : `${summarize(row.body)} @${String(row.timestamp)}`;
}

/** How `diffRecords` names a whole record that one side lacks. */
export function recordAt(body: string, at: number): string {
  return `${summarize(body)} @t+${at}`;
}

/** Field-level differences, lane by lane, in each lane's own order. */
export function diffRecords(oracle: readonly LogRecord[], current: readonly LogRecord[]): Diff[] {
  const left = byLane(oracle);
  const right = byLane(current);
  const lanes = [...new Set([...left.keys(), ...right.keys()])].sort();
  const diffs: Diff[] = [];
  for (const lane of lanes) {
    const a = left.get(lane) ?? [];
    const b = right.get(lane) ?? [];
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const o = a[index];
      const c = b[index];
      if (o === undefined || c === undefined) {
        diffs.push({ lane, index, field: "record", oracle: recordSummary(o), current: recordSummary(c) });
        continue;
      }
      for (const field of [...new Set([...Object.keys(o), ...Object.keys(c)])].sort()) {
        if (!Bun.deepEquals(o[field], c[field], true)) {
          diffs.push({ lane, index, field, oracle: summarize(o[field]), current: summarize(c[field]) });
        }
      }
    }
  }
  return diffs;
}

export function declaredDiffs(fixture: IngestFixture): Diff[] {
  return (fixture.intended ?? []).map(({ lane, index, field, oracle, current }) => ({ lane, index, field, oracle, current }));
}

/**
 * Records whose time is not the read time of one of their lane's reads. A
 * line is stamped when its bytes were read (a fold, when its first line was),
 * never when the pipeline got round to parsing it.
 */
export function unreadTimestamps(fixture: IngestFixture, records: readonly LogRecord[]): string[] {
  const reads = new Map<string, Set<number>>();
  const note = (lane: string, at: number): void => {
    const set = reads.get(lane) ?? new Set<number>();
    set.add(FIXTURE_EPOCH_MS + at);
    reads.set(lane, set);
  };
  for (const event of fixture.events) {
    if ("chunk" in event) {
      note(laneOf({ service: event.chunk.service, source: event.chunk.stream, stream: event.chunk.stream }), event.at);
    } else if ("append" in event) {
      note(laneOf(event.append), event.at);
    }
  }
  const bad: string[] = [];
  for (const record of records) {
    const ms = Date.parse(record.timestamp);
    const lane = laneOf(record);
    if (!reads.get(lane)?.has(ms) || nanosAsMs(record.timeUnixNano) !== ms) {
      bad.push(`${lane} ${summarize(record.body)} @${relativeMs(ms)}`);
    }
  }
  return bad;
}
