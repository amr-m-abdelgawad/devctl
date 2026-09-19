import { describe, expect, test } from "bun:test";
import { GRPC_FRAME_PREFIX_BYTES, splitGrpcFrames } from "./grpc-frames.ts";

function frame(message: Uint8Array | string, compressed = false): Uint8Array {
  const body = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const out = new Uint8Array(GRPC_FRAME_PREFIX_BYTES + body.length);
  out[0] = compressed ? 1 : 0;
  const view = new DataView(out.buffer);
  view.setUint32(1, body.length);
  out.set(body, GRPC_FRAME_PREFIX_BYTES);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("splitGrpcFrames", () => {
  test("splits concatenated uncompressed and compressed frames", () => {
    const first = frame("one");
    const second = frame(new Uint8Array([1, 2, 3]), true);
    const split = splitGrpcFrames(concat([first, second]));
    expect(split.truncated).toBe(false);
    expect(split.frames).toHaveLength(2);
    expect(split.frames[0]?.compressed).toBe(false);
    expect(new TextDecoder().decode(split.frames[0]?.message ?? new Uint8Array())).toBe("one");
    expect(split.frames[1]?.compressed).toBe(true);
    expect(Array.from(split.frames[1]?.message ?? [])).toEqual([1, 2, 3]);
  });

  test("drops a trailing incomplete prefix and sets truncated", () => {
    const complete = frame("ok");
    const split = splitGrpcFrames(concat([complete, new Uint8Array([0, 0, 0])]));
    expect(split.frames).toHaveLength(1);
    expect(split.truncated).toBe(true);
    expect(new TextDecoder().decode(split.frames[0]?.message ?? new Uint8Array())).toBe("ok");
  });

  test("drops a trailing incomplete payload and sets truncated", () => {
    const prefix = new Uint8Array([0, 0, 0, 0, 8, 1, 2, 3]);
    const split = splitGrpcFrames(prefix);
    expect(split.frames).toEqual([]);
    expect(split.truncated).toBe(true);
  });

  test("empty input is not truncated", () => {
    expect(splitGrpcFrames(new Uint8Array())).toEqual({ frames: [], truncated: false });
  });
});
