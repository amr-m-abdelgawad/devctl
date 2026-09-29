import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CREDIT_PER_STREAM_BYTES,
  CREDIT_TOTAL_BYTES,
  DEFAULT_LOG_CAP_BYTES,
  PROCESS_SLICE_MS,
  SPILL_PER_STREAM_BYTES,
  SPILL_TOTAL_BYTES,
} from "../../../domain/logs/budgets.ts";
import { LineSplitter } from "./line-splitter.ts";
import { OrderedSpool, type SpoolFrame, type SpoolHeader } from "./spool.ts";

export type PipelineChunk = {
  session: string;
  service: string;
  stream: string;
  pid: number;
  readAtMs: number;
  bytes: Buffer;
};

export type PipelineStreamKey = Pick<PipelineChunk, "service" | "stream" | "pid">;

export type PipelineLine = {
  service: string;
  stream: string;
  pid: number;
  readAtMs: number;
  line: string;
};

/**
 * One output stream's bytes, oldest first: `head` frames in memory, then the
 * spooled segments on disk, then `tail` frames in memory. Once anything is
 * spooled, newer bytes queue in `tail` behind it, so the splitter always sees
 * the stream in read order.
 */
type StreamState = {
  key: string;
  header: SpoolHeader;
  head: SpoolFrame[];
  headIndex: number;
  headBytes: number;
  tail: SpoolFrame[];
  tailBytes: number;
  splitter: LineSplitter;
  spool: OrderedSpool | undefined;
  servedBytes: number;
  lastReadAtMs: number;
  ended: boolean;
};

export type PipelineLimits = {
  spillPerStream?: number;
  spillTotal?: number;
  creditPerStream?: number;
  creditTotal?: number;
  /** One budget for every stream's spool together. */
  spoolMaxBytes?: number;
};

/**
 * Single owner of per-stream queues. Memory spills to an ordered spool well
 * below the credit window, so the reader only stops when the spool itself
 * cannot take more.
 */
export class IngestPipeline {
  private readonly streams = new Map<string, StreamState>();
  private memoryBytes = 0;
  private spooledTotal = 0;
  private readonly spillPerStream: number;
  private readonly spillTotal: number;
  private readonly creditPerStream: number;
  private readonly creditTotal: number;
  private readonly spoolMaxBytes: number;
  /** Spooled segments that could not be read back. */
  loss = 0;
  /** True from a refused chunk until the pipeline next makes progress. */
  paused = false;
  /** True while the last spool write failed for lack of disk space. */
  diskFull = false;

  constructor(
    private readonly spoolRoot: string,
    limits: PipelineLimits = {},
  ) {
    this.spillPerStream = limits.spillPerStream ?? SPILL_PER_STREAM_BYTES;
    this.spillTotal = limits.spillTotal ?? SPILL_TOTAL_BYTES;
    this.creditPerStream = limits.creditPerStream ?? CREDIT_PER_STREAM_BYTES;
    this.creditTotal = limits.creditTotal ?? CREDIT_TOTAL_BYTES;
    this.spoolMaxBytes = limits.spoolMaxBytes ?? DEFAULT_LOG_CAP_BYTES;
    mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
  }

  inFlightBytes(): number {
    return this.memoryBytes;
  }

  spooledBytes(): number {
    return this.spooledTotal;
  }

  /**
   * Takes a chunk in read order. Returns false only when the chunk fits
   * neither the credit window nor the spool budget; the caller keeps it and
   * offers it again, which is what stops the reader. `force` takes it anyway,
   * for bytes that would otherwise be lost at shutdown.
   */
  enqueueChunk(chunk: PipelineChunk, force = false): boolean {
    const incoming = chunk.bytes.byteLength;
    if (incoming === 0) {
      return true;
    }
    const state = this.streamFor(chunk);
    state.ended = false;
    const frame: SpoolFrame = { readAtMs: chunk.readAtMs, bytes: chunk.bytes };
    if (!spilling(state) && state.headBytes + incoming <= this.spillPerStream && this.memoryBytes + incoming <= this.spillTotal) {
      state.head.push(frame);
      state.headBytes += incoming;
      this.memoryBytes += incoming;
      return true;
    }
    const overCredit = state.headBytes + state.tailBytes + incoming > this.creditPerStream || this.memoryBytes + incoming > this.creditTotal;
    state.tail.push(frame);
    state.tailBytes += incoming;
    this.memoryBytes += incoming;
    if (overCredit || state.tailBytes >= this.spillPerStream || this.memoryBytes >= this.spillTotal) {
      const flushed = this.flushTail(state);
      if (overCredit && !flushed && !force) {
        state.tail.pop();
        state.tailBytes -= incoming;
        this.memoryBytes -= incoming;
        this.paused = true;
        return false;
      }
    }
    return true;
  }

  /**
   * Marks a stream finished. Its last unterminated line is emitted once its
   * queued bytes are processed, and its state and spool directory are freed.
   */
  endStream(key: PipelineStreamKey): void {
    const state = this.streams.get(streamKey(key));
    if (state !== undefined) {
      state.ended = true;
    }
  }

  /** Processes byte-fair stream data for up to `sliceMs`. Returns true while more is queued. */
  processSlice(emit: (line: PipelineLine) => void, sliceMs = PROCESS_SLICE_MS, now = Date.now()): boolean {
    const deadline = now + sliceMs;
    let progressed = false;
    while (Date.now() < deadline) {
      const state = this.fairest();
      if (state === undefined || !this.emitOne(state, emit)) {
        break;
      }
      progressed = true;
    }
    this.retireEnded(emit);
    if (progressed) {
      this.paused = false;
    }
    return this.pending();
  }

  /**
   * Prepares for shutdown: in-memory bytes that are next in line are
   * processed, newer ones are written behind the spool for the next daemon
   * to replay, and streams with nothing spooled emit their last partial line.
   */
  drainForClose(emit: (line: PipelineLine) => void): void {
    for (const state of this.streams.values()) {
      if (state.spool === undefined || state.spool.segmentCount() === 0) {
        while (this.emitOne(state, emit)) {
          // a stream with nothing spooled is processed to its end
        }
        this.emitRest(state, emit);
        continue;
      }
      while (state.headIndex < state.head.length) {
        this.emitOne(state, emit);
      }
      // What the splitter holds would otherwise precede bytes it can no longer meet.
      this.emitRest(state, emit);
      // Past the budget if need be: the tail is at most one credit window, and dropping it loses lines.
      this.flushTail(state, Number.POSITIVE_INFINITY);
    }
  }

  pending(): boolean {
    for (const state of this.streams.values()) {
      if (hasData(state) || state.ended) {
        return true;
      }
    }
    return false;
  }

  private emitOne(state: StreamState, emit: (line: PipelineLine) => void): boolean {
    if (state.headIndex >= state.head.length && !this.hydrate(state)) {
      return false;
    }
    const frame = state.head[state.headIndex]!;
    state.headIndex += 1;
    if (state.headIndex === state.head.length) {
      state.head = [];
      state.headIndex = 0;
    }
    const size = frame.bytes.byteLength;
    state.headBytes -= size;
    this.memoryBytes -= size;
    state.servedBytes += size;
    state.lastReadAtMs = frame.readAtMs;
    for (const line of state.splitter.push(frame.bytes)) {
      emit({ service: state.header.service, stream: state.header.stream, pid: state.header.pid, readAtMs: frame.readAtMs, line });
    }
    return true;
  }

  // Refills an empty head: the oldest spooled segment first, then the tail.
  private hydrate(state: StreamState): boolean {
    while (state.spool !== undefined && state.spool.segmentCount() > 0) {
      const segment = state.spool.consumeNext();
      if (segment === undefined) {
        break;
      }
      this.spooledTotal -= segment.bytes;
      if (segment.frames.length === 0) {
        this.loss += 1;
        continue;
      }
      let bytes = 0;
      for (const frame of segment.frames) {
        bytes += frame.bytes.byteLength;
      }
      state.head = segment.frames;
      state.headIndex = 0;
      state.headBytes = bytes;
      this.memoryBytes += bytes;
      return true;
    }
    if (state.tail.length === 0) {
      return false;
    }
    state.head = state.tail;
    state.headIndex = 0;
    state.headBytes = state.tailBytes;
    state.tail = [];
    state.tailBytes = 0;
    return true;
  }

  // Writes the tail as the newest spool segment within the shared budget.
  private flushTail(state: StreamState, room = this.spoolMaxBytes - this.spooledTotal): boolean {
    if (state.tail.length === 0) {
      return true;
    }
    const spool = this.spoolFor(state);
    const before = spool.size();
    const result = spool.append(state.header, state.tail, room);
    if (result !== "ok") {
      this.diskFull = result === "disk";
      return false;
    }
    this.diskFull = false;
    this.spooledTotal += spool.size() - before;
    this.memoryBytes -= state.tailBytes;
    state.tail = [];
    state.tailBytes = 0;
    return true;
  }

  private emitRest(state: StreamState, emit: (line: PipelineLine) => void): void {
    for (const line of state.splitter.finish()) {
      emit({ service: state.header.service, stream: state.header.stream, pid: state.header.pid, readAtMs: state.lastReadAtMs, line });
    }
  }

  private retireEnded(emit: (line: PipelineLine) => void): void {
    for (const state of this.streams.values()) {
      if (!state.ended || hasData(state)) {
        continue;
      }
      this.emitRest(state, emit);
      state.spool?.remove();
      this.streams.delete(state.key);
    }
  }

  private fairest(): StreamState | undefined {
    let best: StreamState | undefined;
    for (const state of this.streams.values()) {
      if (hasData(state) && (best === undefined || state.servedBytes < best.servedBytes)) {
        best = state;
      }
    }
    return best;
  }

  private spoolFor(state: StreamState): OrderedSpool {
    if (state.spool === undefined) {
      state.spool = new OrderedSpool(join(this.spoolRoot, `${sessionSpoolPrefix(state.header.session)}${safeKey(state.key)}`));
    }
    return state.spool;
  }

  private streamFor(chunk: PipelineChunk): StreamState {
    const key = streamKey(chunk);
    const existing = this.streams.get(key);
    if (existing) {
      return existing;
    }
    const created: StreamState = {
      key,
      header: { session: chunk.session, service: chunk.service, stream: chunk.stream, pid: chunk.pid },
      head: [],
      headIndex: 0,
      headBytes: 0,
      tail: [],
      tailBytes: 0,
      splitter: new LineSplitter(),
      spool: undefined,
      servedBytes: this.leastServed(),
      lastReadAtMs: chunk.readAtMs,
      ended: false,
    };
    this.streams.set(key, created);
    return created;
  }

  // A new stream starts level with the least-served one instead of at zero,
  // so it shares the pipeline fairly rather than monopolizing it.
  private leastServed(): number {
    let least: number | undefined;
    for (const state of this.streams.values()) {
      if (hasData(state) && (least === undefined || state.servedBytes < least)) {
        least = state.servedBytes;
      }
    }
    return least ?? 0;
  }
}

function spilling(state: StreamState): boolean {
  return state.tail.length > 0 || (state.spool !== undefined && state.spool.segmentCount() > 0);
}

function hasData(state: StreamState): boolean {
  return state.headIndex < state.head.length || state.tail.length > 0 || (state.spool !== undefined && state.spool.segmentCount() > 0);
}

function streamKey(key: PipelineStreamKey): string {
  return `${key.service}\0${key.stream}\0${key.pid}`;
}

/** Every spool directory a session's pipeline creates starts with this. */
export function sessionSpoolPrefix(session: string): string {
  return `${safeKey(session)}_`;
}

function safeKey(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned === "" ? "stream" : cleaned;
}
