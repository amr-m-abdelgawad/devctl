import { describe, expect, test } from "bun:test";
import type { ProcessChunkMeta } from "../../ports/process-runtime.ts";
import { pumpChunks } from "./output-pump.ts";

type Delivery = { text: string; meta?: ProcessChunkMeta; at: number };

function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // a read that completes measurably later than the one before it
  }
}

// Each part is read when the pump asks for it; `before` runs inside that read.
function reads(parts: { text: string; before?: () => void }[]): { stream: AsyncIterable<Uint8Array>; readAt: number[] } {
  const readAt: number[] = [];
  let index = 0;
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const part = parts[index];
        index += 1;
        if (part === undefined) {
          return { done: true, value: undefined };
        }
        part.before?.();
        readAt.push(Date.now());
        return { done: false, value: Buffer.from(part.text) };
      },
    }),
  };
  return { stream, readAt };
}

function recorder(accept: (call: number) => boolean = () => true): { deliveries: Delivery[]; handler: (stream: "stdout" | "stderr", bytes: Uint8Array, meta?: ProcessChunkMeta) => boolean } {
  const deliveries: Delivery[] = [];
  let calls = 0;
  return {
    deliveries,
    handler: (_stream, bytes, meta) => {
      calls += 1;
      deliveries.push({ text: Buffer.from(bytes).toString("utf8"), meta, at: Date.now() });
      return accept(calls);
    },
  };
}

describe("pumpChunks read time", () => {
  test("a coalesced chunk carries the time its first read completed", async () => {
    const { stream, readAt } = reads([{ text: "Traceback (most " }, { text: "recent call last):\n", before: () => spin(2) }]);
    const { deliveries, handler } = recorder();
    await pumpChunks(stream, "stdout", handler, { yieldEveryRead: false });
    const data = deliveries.filter((delivery) => delivery.meta?.end !== true);
    expect(data.map((delivery) => delivery.text).join("")).toBe("Traceback (most recent call last):\n");
    // Both reads normally fall inside one coalescing window; on a stalled host
    // they may not, and each chunk must still carry its own first read's time.
    expect(data[0]!.meta?.readAtMs).toBeGreaterThanOrEqual(readAt[0]!);
    expect(data[0]!.meta!.readAtMs!).toBeLessThan(readAt[1]!);
    if (data.length === 2) {
      expect(data[1]!.meta!.readAtMs!).toBeGreaterThanOrEqual(readAt[1]!);
    }
    expect(deliveries.at(-1)?.meta?.end).toBe(true);
  });

  test("a chunk held back by a paused pipeline keeps its read time", async () => {
    let releaseAt = Number.POSITIVE_INFINITY;
    const { stream, readAt } = reads([{ text: "late line\n", before: () => {
      releaseAt = Date.now() + 60;
    } }]);
    const { deliveries, handler } = recorder();
    await pumpChunks(stream, "stdout", handler, { paused: () => Date.now() < releaseAt });
    const [data] = deliveries;
    expect(data?.text).toBe("late line\n");
    expect(data!.at).toBeGreaterThanOrEqual(releaseAt);
    expect(data!.meta!.readAtMs!).toBeGreaterThanOrEqual(readAt[0]!);
    expect(data!.meta!.readAtMs!).toBeLessThan(releaseAt - 50);
  });

  test("a refused chunk is offered again with the same read time", async () => {
    const { stream, readAt } = reads([{ text: "retry me\n" }]);
    const { deliveries, handler } = recorder((call) => call > 3);
    await pumpChunks(stream, "stdout", handler);
    const offers = deliveries.filter((delivery) => delivery.meta?.end !== true);
    expect(offers).toHaveLength(4);
    expect(new Set(offers.map((offer) => offer.meta?.readAtMs)).size).toBe(1);
    expect(offers[0]!.meta!.readAtMs!).toBeGreaterThanOrEqual(readAt[0]!);
    expect(offers[3]!.at - offers[0]!.meta!.readAtMs!).toBeGreaterThanOrEqual(10);
  });
});
