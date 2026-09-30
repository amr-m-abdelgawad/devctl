import { MAX_LOG_LINE_CHARS } from "../../domain/logs/types.ts";
import { COALESCE_BYTES, COALESCE_MS, SPLIT_MAX_BYTES } from "../../domain/logs/budgets.ts";
import { LineSplitter } from "../storage/ingest/line-splitter.ts";
import type { ProcessChunkHandler } from "../../ports/process-runtime.ts";

export type StreamName = "stdout" | "stderr";
export type LineHandler = (stream: StreamName, line: string) => void;
export type ChunkHandler = ProcessChunkHandler;

const MAX_LINE_BYTES = 1024 * 1024;
const PAUSE_POLL_MS = 5;

export type PumpOptions = {
  /** Stop reading while this returns true (credit exhausted or spool full). */
  paused?: () => boolean;
  /** Force-break an unterminated line at this many bytes. */
  maxLineBytes?: number;
  /** When set, emit at most this many UTF-16 units and skip the rest of the line. */
  maxChars?: number;
  yieldEveryRead?: boolean;
};

export async function pumpLines(
  stream: ReadableStream<Uint8Array> | number | undefined,
  kind: StreamName,
  handler?: LineHandler,
  options: PumpOptions = {},
): Promise<void> {
  if (!stream || typeof stream === "number" || !handler) {
    return;
  }
  const decoder = new TextDecoder();
  const splitter = options.maxChars === undefined
    ? undefined
    : new LineSplitter({ maxBytes: options.maxLineBytes ?? SPLIT_MAX_BYTES, maxChars: options.maxChars });
  let buf = "";
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  try {
    for await (const value of stream) {
      if (value.byteLength > 0) {
        const owned = new Uint8Array(value.byteLength);
        owned.set(value);
        buf = emitChunk(kind, handler, splitter, decoder, buf, owned, maxLineBytes);
      }
      // Lines are handed on as they are read, so the handler's clock is their read
      // time; a paused store holds off the next read instead.
      await waitUntilReadable(options.paused);
      if (options.yieldEveryRead !== false) {
        await yieldMacrotask();
      }
    }
  } catch {
    // The child exited and cancelled the pipe. Flush whatever was already read.
  }
  flushTail(kind, handler, splitter, buf);
}

function emitChunk(
  kind: StreamName,
  handler: LineHandler,
  splitter: LineSplitter | undefined,
  decoder: TextDecoder,
  buf: string,
  owned: Uint8Array,
  maxLineBytes: number,
): string {
  if (splitter) {
    for (const line of splitter.push(owned)) {
      handler(kind, line);
    }
    return buf;
  }
  let pending = buf + decoder.decode(owned, { stream: true });
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    handler(kind, line.replace(/\r$/, ""));
  }
  if (Buffer.byteLength(pending, "utf8") >= maxLineBytes) {
    handler(kind, pending.replace(/\r$/, "").slice(0, MAX_LOG_LINE_CHARS));
    return "";
  }
  return pending;
}

function flushTail(kind: StreamName, handler: LineHandler, splitter: LineSplitter | undefined, buf: string): void {
  if (splitter) {
    for (const line of splitter.finish()) {
      handler(kind, line);
    }
    return;
  }
  if (buf !== "") {
    handler(kind, buf);
  }
}

async function waitUntilReadable(paused?: () => boolean): Promise<void> {
  while (paused?.() === true) {
    await new Promise((resolve) => {
      setTimeout(resolve, PAUSE_POLL_MS);
    });
  }
}

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

type ByteStream = AsyncIterable<Uint8Array>;

// A read and the time it completed, taken when the read settles rather than
// when the pump gets to it: a pump waiting to deliver still stamps it on time.
type StampedRead = { result: IteratorResult<Uint8Array>; readAtMs: number };

type TakenChunk = { bytes: Uint8Array; readAtMs: number };

/**
 * Coalesces reads up to 256 KiB or 5 ms. A handler that returns false keeps
 * the chunk; the caller retries it after the pipeline has room. Each chunk
 * carries the time its first read completed, however late it is delivered.
 */
export async function pumpChunks(
  stream: ReadableStream<Uint8Array> | ByteStream | number | undefined,
  kind: StreamName,
  handler?: ChunkHandler,
  options: PumpOptions = {},
): Promise<void> {
  if (!stream || typeof stream === "number" || !handler) {
    return;
  }
  const iterator = stream[Symbol.asyncIterator]();
  let pendingRead = stampRead(iterator.next());
  let parts: Uint8Array[] = [];
  let pendingBytes = 0;
  let firstReadAtMs = 0;
  const take = (): TakenChunk | undefined => {
    const merged = mergeParts(parts, pendingBytes);
    const readAtMs = firstReadAtMs;
    parts = [];
    pendingBytes = 0;
    firstReadAtMs = 0;
    return merged === undefined ? undefined : { bytes: merged, readAtMs };
  };
  try {
    while (true) {
      const step = await nextPumpStep(pendingRead, pendingBytes > 0);
      if (step.kind === "tick") {
        await deliverChunk(kind, handler, options, take());
        continue;
      }
      pendingRead = stampRead(iterator.next());
      if (step.result.done === true) {
        break;
      }
      const owned = copyBytes(step.result.value);
      const aged = pendingBytes > 0 && step.readAtMs - firstReadAtMs >= COALESCE_MS;
      const overflow = pendingBytes > 0 && pendingBytes + owned.byteLength > COALESCE_BYTES;
      if (aged || overflow) {
        await deliverChunk(kind, handler, options, take());
      }
      if (pendingBytes === 0) {
        firstReadAtMs = step.readAtMs;
      }
      parts.push(owned);
      pendingBytes += owned.byteLength;
      if (pendingBytes >= COALESCE_BYTES) {
        await deliverChunk(kind, handler, options, take());
      }
      if (options.yieldEveryRead !== false) {
        await yieldMacrotask();
      }
    }
  } catch {
    // The child exited and cancelled the pipe. Deliver whatever was already read.
  }
  await deliverChunk(kind, handler, options, take());
  await deliverEnd(kind, handler);
}

function stampRead(read: Promise<IteratorResult<Uint8Array>>): Promise<StampedRead> {
  return read.then((result) => ({ result, readAtMs: Date.now() }));
}

async function nextPumpStep(
  pendingRead: Promise<StampedRead>,
  coalesce: boolean,
): Promise<{ kind: "tick" } | ({ kind: "read" } & StampedRead)> {
  if (!coalesce) {
    return { kind: "read", ...(await pendingRead) };
  }
  return Promise.race([
    pendingRead.then((read) => ({ kind: "read" as const, ...read })),
    sleepMs(COALESCE_MS).then(() => ({ kind: "tick" as const })),
  ]);
}

async function deliverChunk(
  kind: StreamName,
  handler: ChunkHandler,
  options: PumpOptions,
  chunk: TakenChunk | undefined,
): Promise<void> {
  if (chunk === undefined || chunk.bytes.byteLength === 0) {
    return;
  }
  const meta = { readAtMs: chunk.readAtMs };
  let accepted = false;
  while (!accepted) {
    await waitUntilReadable(options.paused);
    accepted = handler(kind, chunk.bytes, meta) !== false;
    if (!accepted) {
      await sleepMs(PAUSE_POLL_MS);
    }
  }
}

const NO_BYTES = new Uint8Array(0);

/** Tells the handler the stream is finished, so it can emit a last line that had no newline. */
export async function deliverEnd(kind: StreamName, handler: ChunkHandler): Promise<void> {
  while (handler(kind, NO_BYTES, { end: true }) === false) {
    await sleepMs(PAUSE_POLL_MS);
  }
}

function mergeParts(parts: Uint8Array[], total: number): Uint8Array | undefined {
  if (parts.length === 0 || total === 0) {
    return undefined;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

function copyBytes(value: Uint8Array): Uint8Array {
  const owned = new Uint8Array(value.byteLength);
  owned.set(value);
  return owned;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
