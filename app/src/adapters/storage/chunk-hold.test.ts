import { describe, expect, test } from "bun:test";
import { ChunkHoldQueue } from "./chunk-hold.ts";

type Chunk = { id: number; service: string; stream: string; pid: number; end?: boolean };

function chunk(id: number, service = "api", end = false): Chunk {
  return { id, service, stream: "stdout", pid: 1, end };
}

describe("chunk hold queue", () => {
  test("acks a refused chunk only once it is accepted, and keeps its stream in order", () => {
    let room = false;
    const accepted: number[] = [];
    const acked: number[] = [];
    const queue = new ChunkHoldQueue<Chunk>((item, force) => {
      if (!room && !force && item.end !== true) {
        return false;
      }
      accepted.push(item.id);
      return true;
    }, (item) => acked.push(item.id));
    expect(queue.offer(chunk(1))).toBe(false);
    // Would fit, but must wait behind chunk 1 of the same stream.
    expect(queue.offer(chunk(2, "api", true))).toBe(false);
    expect(acked).toEqual([]);
    queue.retry();
    expect(acked).toEqual([]);
    room = true;
    queue.retry();
    expect(accepted).toEqual([1, 2]);
    expect(acked).toEqual([1, 2]);
    expect(queue.holding).toBe(false);
  });

  test("one stream's held chunks do not hold up another stream", () => {
    const acked: number[] = [];
    const queue = new ChunkHoldQueue<Chunk>((item) => item.service !== "flood", (item) => acked.push(item.id));
    queue.offer(chunk(1, "flood"));
    expect(queue.offer(chunk(2, "quiet"))).toBe(true);
    expect(acked).toEqual([2]);
  });

  test("shutdown forces every held chunk in", () => {
    const acked: number[] = [];
    const queue = new ChunkHoldQueue<Chunk>((_item, force) => force, (item) => acked.push(item.id));
    queue.offer(chunk(1));
    queue.offer(chunk(2));
    queue.retry(true);
    expect(acked).toEqual([1, 2]);
  });
});
