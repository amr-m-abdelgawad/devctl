import { MAX_LOG_LINE_CHARS } from "../../domain/logs/types.ts";
import { COALESCE_BYTES, COALESCE_MS, SPLIT_MAX_BYTES } from "../../domain/logs/budgets.ts";
import { LineSplitter } from "../storage/ingest/line-splitter.ts";

export type StreamName = "stdout" | "stderr";
export type LineHandler = (stream: StreamName, line: string) => void;
export type ChunkHandler = (stream: StreamName, bytes: Uint8Array) => boolean;

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
      await waitUntilReadable(options.paused);
      if (value.byteLength > 0) {
        const owned = new Uint8Array(value.byteLength);
        owned.set(value);
        buf = emitChunk(kind, handler, splitter, decoder, buf, owned, maxLineBytes);
      }
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

/**
 * Coalesces reads up to 256 KiB or 5 ms. A handler that returns false keeps
 * the chunk; the caller retries it after the pipeline has room.
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
  let pendingRead = iterator.next();
  let parts: Uint8Array[] = [];
  let pendingBytes = 0;
  let startedAt = 0;
  const take = (): Uint8Array | undefined => {
    const merged = mergeParts(parts, pendingBytes);
    parts = [];
    pendingBytes = 0;
    startedAt = 0;
    return merged;
  };
  try {
    while (true) {
      const step = await nextPumpStep(pendingRead, pendingBytes > 0);
      if (step.kind === "tick") {
        await deliverChunk(kind, handler, options, take());
        continue;
      }
      pendingRead = iterator.next();
      if (step.result.done === true) {
        break;
      }
      const owned = copyBytes(step.result.value);
      if (startedAt === 0) {
        startedAt = Date.now();
      }
      const aged = Date.now() - startedAt >= COALESCE_MS;
      const overflow = pendingBytes > 0 && pendingBytes + owned.byteLength > COALESCE_BYTES;
      if (pendingBytes > 0 && (aged || overflow)) {
        await deliverChunk(kind, handler, options, take());
        startedAt = Date.now();
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
}

async function nextPumpStep(
  pendingRead: Promise<IteratorResult<Uint8Array>>,
  coalesce: boolean,
): Promise<{ kind: "tick" } | { kind: "read"; result: IteratorResult<Uint8Array> }> {
  if (!coalesce) {
    return { kind: "read", result: await pendingRead };
  }
  return Promise.race([
    pendingRead.then((result) => ({ kind: "read" as const, result })),
    sleepMs(COALESCE_MS).then(() => ({ kind: "tick" as const })),
  ]);
}

async function deliverChunk(
  kind: StreamName,
  handler: ChunkHandler,
  options: PumpOptions,
  bytes: Uint8Array | undefined,
): Promise<void> {
  if (bytes === undefined || bytes.byteLength === 0) {
    return;
  }
  let accepted = false;
  while (!accepted) {
    await waitUntilReadable(options.paused);
    accepted = handler(kind, bytes) !== false;
    if (!accepted) {
      await sleepMs(PAUSE_POLL_MS);
    }
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
