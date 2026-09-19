const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;
const MAX_FIELD = 536_870_911;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Schema-free proto3 decode_raw. Keys are field numbers as strings.
// Length-delimited values prefer printable UTF-8, then a nested message,
// then packed repeated scalars, then base64 for leftover bytes.
export function decodeProtobufRaw(bytes: Uint8Array): Record<string, unknown> | undefined {
  return readMessage(bytes);
}

function readMessage(bytes: Uint8Array): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let offset = 0;
  if (bytes.length === 0) {
    return {};
  }
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (key === undefined) {
      return undefined;
    }
    offset = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (!Number.isInteger(field) || field < 1 || field > MAX_FIELD) {
      return undefined;
    }
    const decoded = readField(bytes, offset, wire);
    if (decoded === undefined) {
      return undefined;
    }
    offset = decoded.next;
    const name = String(field);
    out[name] = mergeField(out[name], decoded.value);
  }
  return out;
}

function readField(
  bytes: Uint8Array,
  offset: number,
  wire: number,
): { value: unknown; next: number } | undefined {
  if (wire === WIRE_VARINT) {
    const value = readVarint(bytes, offset);
    if (value === undefined) {
      return undefined;
    }
    return { value: varintToJson(value.value), next: value.next };
  }
  if (wire === WIRE_I64) {
    if (offset + 8 > bytes.length) {
      return undefined;
    }
    return { value: readFloat64(bytes, offset), next: offset + 8 };
  }
  if (wire === WIRE_I32) {
    if (offset + 4 > bytes.length) {
      return undefined;
    }
    return { value: readFloat32(bytes, offset), next: offset + 4 };
  }
  if (wire !== WIRE_LEN) {
    return undefined;
  }
  const len = readVarint(bytes, offset);
  if (len === undefined || len.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  const size = Number(len.value);
  const start = len.next;
  const end = start + size;
  if (size < 0 || end > bytes.length) {
    return undefined;
  }
  return { value: decodeLengthDelimited(bytes.subarray(start, end)), next: end };
}

function decodeLengthDelimited(payload: Uint8Array): unknown {
  if (isPrintableUtf8(payload)) {
    return new TextDecoder().decode(payload);
  }
  const nested = readMessage(payload);
  if (nested !== undefined) {
    return nested;
  }
  const packedVarints = readPackedVarints(payload);
  if (packedVarints !== undefined) {
    return packedVarints;
  }
  const packedI64 = readPackedFixed(payload, 8, readFloat64);
  if (packedI64 !== undefined) {
    return packedI64;
  }
  const packedI32 = readPackedFixed(payload, 4, readFloat32);
  if (packedI32 !== undefined) {
    return packedI32;
  }
  return bytesToBase64(payload);
}

function readPackedVarints(bytes: Uint8Array): Array<number | string> | undefined {
  if (bytes.length === 0) {
    return undefined;
  }
  const values: Array<number | string> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const value = readVarint(bytes, offset);
    if (value === undefined) {
      return undefined;
    }
    values.push(varintToJson(value.value));
    offset = value.next;
  }
  return values.length > 0 ? values : undefined;
}

function readPackedFixed(
  bytes: Uint8Array,
  width: number,
  read: (buf: Uint8Array, offset: number) => number,
): number[] | undefined {
  if (bytes.length === 0 || bytes.length % width !== 0) {
    return undefined;
  }
  const values: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    values.push(read(bytes, offset));
  }
  return values;
}

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } | undefined {
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i += 1) {
    const at = offset + i;
    if (at >= bytes.length) {
      return undefined;
    }
    const b = bytes[at] ?? 0;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value, next: at + 1 };
    }
    shift += 7n;
  }
  return undefined;
}

function varintToJson(value: bigint): number | string {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return value.toString();
}

function readFloat64(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getFloat64(0, true);
}

function readFloat32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true);
}

function mergeField(existing: unknown, value: unknown): unknown {
  if (existing === undefined) {
    return value;
  }
  const left = Array.isArray(existing) ? existing : [existing];
  if (Array.isArray(value)) {
    return left.concat(value);
  }
  left.push(value);
  return left;
}

function isPrintableUtf8(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 0x09 || code === 0x0a || code === 0x0d) {
        continue;
      }
      if (code < 0x20 || code === 0x7f) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += B64[(n >> 6) & 63];
    out += B64[n & 63];
  }
  if (i < bytes.length) {
    const a = bytes[i] ?? 0;
    const b = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : 0;
    const n = (a << 16) | (b << 8);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += "=";
  }
  return out;
}
