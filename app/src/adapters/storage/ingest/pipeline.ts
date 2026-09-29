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
import { OrderedSpool, type SpoolAppendResult, type SpoolFrame, type SpoolHeader } from "./spool.ts";

export type PipelineChunk = {
  session: string;
  service: string;
  stream: string;
  pid: number;
  readAtMs: number;
  bytes: Buffer;
};

export type PipelineLine = {
  service: string;
  stream: string;
  pid: number;
  readAtMs: number;
  line: string;
  priority: boolean;
};

type StreamState = {
  header: SpoolHeader;
  memory: SpoolFrame[];
  memoryBytes: number;
  splitter: LineSplitter;
  spool: OrderedSpool;
  servedBytes: number;
};

export type PipelineLimits = {
  spillPerStream?: number;
  spillTotal?: number;
  creditPerStream?: number;
  creditTotal?: number;
  spoolMaxBytes?: number;
};

/**
 * Single owner of per-stream queues. Memory spills to an ordered spool well
 * below the credit window, so the reader only stops when the spool itself
 * cannot take more.
 */
export class IngestPipeline {
  private readonly streams = new Map<string, StreamState>();
  private readonly priority: PipelineLine[] = [];
  private memoryBytes = 0;
  private readonly spillPerStream: number;
  private readonly spillTotal: number;
  private readonly creditPerStream: number;
  private readonly creditTotal: number;
  private readonly spoolMaxBytes: number;
  loss = 0;
  paused = false;

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
    let total = 0;
    for (const stream of this.streams.values()) {
      total += stream.spool.size();
    }
    return total;
  }

  enqueuePriority(line: PipelineLine): void {
    this.priority.push(line);
  }

  /**
   * Accepts a chunk into memory, spilling to disk once the spill threshold
   * is crossed. Returns false only when the spool cannot take the bytes and
   * the credit window is already full — the caller keeps the chunk.
   */
  enqueueChunk(chunk: PipelineChunk): boolean {
    const state = this.streamFor(chunk);
    const incoming = chunk.bytes.byteLength;
    if (this.wouldExceedCredit(state, incoming) && !this.canSpill(state, incoming)) {
      this.paused = true;
      return false;
    }
    state.memory.push({ readAtMs: chunk.readAtMs, bytes: chunk.bytes });
    state.memoryBytes += incoming;
    this.memoryBytes += incoming;
    this.spillIfNeeded(state);
    this.paused = this.memoryBytes >= this.creditTotal;
    return true;
  }

  /** Drain priority lines, then byte-fair stream data, for up to `sliceMs`. */
  processSlice(emit: (line: PipelineLine) => void, sliceMs = PROCESS_SLICE_MS, now = Date.now()): boolean {
    const deadline = now + sliceMs;
    this.drainPriority(emit);
    while (Date.now() < deadline) {
      const state = this.fairest();
      if (state === undefined) {
        this.paused = false;
        return false;
      }
      if (!this.emitOne(state, emit)) {
        break;
      }
    }
    this.paused = this.memoryBytes >= this.creditTotal && this.spooledBytes() === 0;
    return this.pending();
  }

  pending(): boolean {
    if (this.priority.length > 0) {
      return true;
    }
    for (const state of this.streams.values()) {
      if (state.memory.length > 0 || state.spool.size() > 0) {
        return true;
      }
    }
    return false;
  }

  private drainPriority(emit: (line: PipelineLine) => void): void {
    const pending = this.priority.splice(0, this.priority.length);
    for (const line of pending) {
      emit(line);
    }
  }

  private emitOne(state: StreamState, emit: (line: PipelineLine) => void): boolean {
    this.hydrate(state);
    const frame = state.memory[0];
    if (frame === undefined) {
      return false;
    }
    const lines = state.splitter.push(frame.bytes);
    state.servedBytes += frame.bytes.byteLength;
    state.memory.shift();
    state.memoryBytes -= frame.bytes.byteLength;
    this.memoryBytes -= frame.bytes.byteLength;
    for (const line of lines) {
      emit({
        service: state.header.service,
        stream: state.header.stream,
        pid: state.header.pid,
        readAtMs: frame.readAtMs,
        line,
        priority: false,
      });
    }
    return true;
  }

  private hydrate(state: StreamState): void {
    if (state.memory.length > 0 || state.spool.size() === 0) {
      return;
    }
    const frames = state.spool.consume();
    for (const frame of frames) {
      state.memory.push(frame);
      state.memoryBytes += frame.bytes.byteLength;
      this.memoryBytes += frame.bytes.byteLength;
    }
  }

  private fairest(): StreamState | undefined {
    let best: StreamState | undefined;
    for (const state of this.streams.values()) {
      const hasData = state.memory.length > 0 || state.spool.size() > 0;
      const fairer = best === undefined || state.servedBytes < best.servedBytes;
      if (hasData && fairer) {
        best = state;
      }
    }
    return best;
  }

  private wouldExceedCredit(state: StreamState, incoming: number): boolean {
    return state.memoryBytes + incoming > this.creditPerStream || this.memoryBytes + incoming > this.creditTotal;
  }

  private canSpill(state: StreamState, incoming: number): boolean {
    return state.spool.size() + state.memoryBytes + incoming <= this.spoolMaxBytes;
  }

  private spillIfNeeded(state: StreamState): void {
    const overStream = state.memoryBytes >= this.spillPerStream;
    const overTotal = this.memoryBytes >= this.spillTotal;
    if (!overStream && !overTotal) {
      return;
    }
    const frames = state.memory.splice(0, state.memory.length);
    const result = this.writeSpool(state, frames);
    if (result === "ok") {
      this.memoryBytes -= state.memoryBytes;
      state.memoryBytes = 0;
      return;
    }
    state.memory = frames;
    if (result === "disk") {
      this.loss += 1;
    }
  }

  private writeSpool(state: StreamState, frames: SpoolFrame[]): SpoolAppendResult {
    if (frames.length === 0) {
      return "ok";
    }
    return state.spool.append(state.header, frames);
  }

  private streamFor(chunk: PipelineChunk): StreamState {
    const key = `${chunk.service}\0${chunk.stream}\0${chunk.pid}`;
    const existing = this.streams.get(key);
    if (existing) {
      return existing;
    }
    const created: StreamState = {
      header: { session: chunk.session, service: chunk.service, stream: chunk.stream, pid: chunk.pid },
      memory: [],
      memoryBytes: 0,
      splitter: new LineSplitter(),
      spool: new OrderedSpool(join(this.spoolRoot, safeKey(key)), this.spoolMaxBytes),
      servedBytes: 0,
    };
    this.streams.set(key, created);
    return created;
  }
}

function safeKey(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned === "" ? "stream" : cleaned;
}
