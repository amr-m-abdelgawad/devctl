import { closeSync, readSync } from "node:fs";

const READ_BYTES = 64 * 1024;
// One wakeup reads at most this much before yielding, so a busy FIFO cannot
// hold the event loop. macOS hands back at most 8 KiB per read.
const BATCH_BYTES = 256 * 1024;
const IDLE_FIRST_MS = 1;
const IDLE_MAX_MS = 100;

/**
 * Output from the non-blocking read end of a service FIFO, pulled with
 * explicit reads. Bun's FIFO streams stall under backpressure on macOS and
 * cannot stop without losing what they read ahead, and blocking reads park a
 * pool thread per stream. Here nothing is read until the consumer pulls, so
 * a consumer that stops pulling stops the writer. An empty FIFO is retried
 * with backoff up to 100 ms. Once `stopped()` is true the next pull never
 * settles: unread output stays in the FIFO for the next reader, and the
 * consumer does not mistake the handoff for the end of the stream. EOF, when
 * every writer has closed, ends the iteration.
 */
export async function* fifoChunks(fd: number, stopped: () => boolean = () => false): AsyncGenerator<Uint8Array> {
  const buf = Buffer.allocUnsafe(READ_BYTES);
  let idleMs = IDLE_FIRST_MS;
  for (;;) {
    if (stopped()) {
      await never();
    }
    const batch = readBatch(fd, buf);
    if (batch === "eof") {
      return;
    }
    if (batch !== undefined) {
      idleMs = IDLE_FIRST_MS;
      yield batch;
      continue;
    }
    await sleepMs(idleMs);
    idleMs = Math.min(idleMs * 2, IDLE_MAX_MS);
  }
}

// Reads until the FIFO is empty or a batch is full. Undefined means nothing
// is available yet; bytes read before EOF are returned first, and the next
// call sees the EOF again.
function readBatch(fd: number, buf: Buffer): Uint8Array | undefined | "eof" {
  const parts: Buffer[] = [];
  let total = 0;
  while (total < BATCH_BYTES) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        break;
      }
      return total > 0 ? Buffer.concat(parts, total) : "eof";
    }
    if (n === 0) {
      return total > 0 ? Buffer.concat(parts, total) : "eof";
    }
    parts.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  return total > 0 ? Buffer.concat(parts, total) : undefined;
}

export function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}
