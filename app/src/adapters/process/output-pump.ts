import { MAX_LOG_LINE_CHARS } from "../../domain/logs/types.ts";
import { SPLIT_MAX_BYTES } from "../../domain/logs/budgets.ts";
import { LineSplitter } from "../storage/ingest/line-splitter.ts";

export type StreamName = "stdout" | "stderr";
export type LineHandler = (stream: StreamName, line: string) => void;

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
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const splitter = options.maxChars === undefined
    ? undefined
    : new LineSplitter({ maxBytes: options.maxLineBytes ?? SPLIT_MAX_BYTES, maxChars: options.maxChars });
  let buf = "";
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  try {
    for (;;) {
      await waitUntilReadable(options.paused);
      const { value, done } = await reader.read();
      if (done) {
        flushTail(kind, handler, splitter, buf);
        return;
      }
      const owned = new Uint8Array(value.byteLength);
      owned.set(value);
      if (splitter) {
        for (const line of splitter.push(owned)) {
          handler(kind, line);
        }
      } else {
        buf += decoder.decode(owned, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          handler(kind, line.replace(/\r$/, ""));
        }
        if (Buffer.byteLength(buf, "utf8") >= maxLineBytes) {
          handler(kind, buf.replace(/\r$/, "").slice(0, MAX_LOG_LINE_CHARS));
          buf = "";
        }
      }
      if (options.yieldEveryRead !== false) {
        await yieldMacrotask();
      }
    }
  } finally {
    reader.releaseLock();
  }
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
