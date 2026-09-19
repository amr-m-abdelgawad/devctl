import { describe, expect, test } from "bun:test";
import { decodeProtobufRaw } from "./protobuf-raw.ts";

function encodeVarint(n: number | bigint): Uint8Array {
  let value = BigInt(n);
  const out: number[] = [];
  while (value >= 0x80n) {
    out.push(Number(value & 0x7fn) | 0x80);
    value >>= 7n;
  }
  out.push(Number(value));
  return Uint8Array.from(out);
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function key(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire);
}

function varintField(field: number, value: number): Uint8Array {
  return joinBytes(key(field, 0), encodeVarint(value));
}

function bytesField(field: number, value: Uint8Array): Uint8Array {
  return joinBytes(key(field, 2), encodeVarint(value.length), value);
}

function stringField(field: number, value: string): Uint8Array {
  return bytesField(field, new TextEncoder().encode(value));
}

function packedVarints(field: number, values: number[]): Uint8Array {
  return bytesField(field, joinBytes(...values.map((value) => encodeVarint(value))));
}

function doubleField(field: number, value: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value, true);
  return joinBytes(key(field, 1), buf);
}

function floatField(field: number, value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, value, true);
  return joinBytes(key(field, 5), buf);
}

describe("decodeProtobufRaw", () => {
  test("round-trips scalars, nested messages, packed repeated, and leftover bytes", () => {
    const leftover = new Uint8Array([0x80]);
    const encoded = joinBytes(
      varintField(1, 42),
      stringField(2, "hello"),
      doubleField(3, 1.5),
      floatField(4, 2.5),
      bytesField(5, varintField(1, 7)),
      packedVarints(6, [1, 2, 3]),
      bytesField(7, leftover),
      varintField(1, 43),
    );
    expect(decodeProtobufRaw(encoded)).toEqual({
      "1": [42, 43],
      "2": "hello",
      "3": 1.5,
      "4": 2.5,
      "5": { "1": 7 },
      "6": [1, 2, 3],
      "7": Buffer.from(leftover).toString("base64"),
    });
  });

  test("returns an empty object for an empty message and undefined for a corrupt tag", () => {
    expect(decodeProtobufRaw(new Uint8Array())).toEqual({});
    expect(decodeProtobufRaw(new Uint8Array([0xff]))).toBeUndefined();
  });
});
