// Schema-driven decode of OTLP/HTTP protobuf bodies (opentelemetry-proto v1)
// into the OTLP/JSON object shape that mapOtlpLogs / mapOtlpTraces read:
// camelCase names, hex trace/span ids, decimal-string 64-bit integers, and
// base64 bytesValue. Only the messages the receiver ingests are described;
// unknown fields are skipped by wire type, as proto3 requires.

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

type FieldType =
  | "string"
  | "hex" // bytes rendered as lowercase hex (trace and span ids)
  | "base64" // bytes rendered as base64 (AnyValue.bytes_value)
  | "uint32" // varint, as a number
  | "int64" // varint, as a decimal string (two's complement for negatives)
  | "bool"
  | "fixed32"
  | "fixed64" // as a decimal string
  | "double"
  | Schema;

type FieldSpec = { name: string; type: FieldType; repeated?: boolean };
type Schema = { [field: number]: FieldSpec };

const ANY_VALUE: Schema = {};
const KEY_VALUE: Schema = { 1: { name: "key", type: "string" }, 2: { name: "value", type: ANY_VALUE } };
const ARRAY_VALUE: Schema = { 1: { name: "values", type: ANY_VALUE, repeated: true } };
const KEY_VALUE_LIST: Schema = { 1: { name: "values", type: KEY_VALUE, repeated: true } };
Object.assign(ANY_VALUE, {
  1: { name: "stringValue", type: "string" },
  2: { name: "boolValue", type: "bool" },
  3: { name: "intValue", type: "int64" },
  4: { name: "doubleValue", type: "double" },
  5: { name: "arrayValue", type: ARRAY_VALUE },
  6: { name: "kvlistValue", type: KEY_VALUE_LIST },
  7: { name: "bytesValue", type: "base64" },
} satisfies Schema);

const ATTRIBUTES: FieldSpec = { name: "attributes", type: KEY_VALUE, repeated: true };
const RESOURCE: Schema = { 1: ATTRIBUTES, 2: { name: "droppedAttributesCount", type: "uint32" } };
const SCOPE: Schema = {
  1: { name: "name", type: "string" },
  2: { name: "version", type: "string" },
  3: ATTRIBUTES,
  4: { name: "droppedAttributesCount", type: "uint32" },
};

const LOG_RECORD: Schema = {
  1: { name: "timeUnixNano", type: "fixed64" },
  11: { name: "observedTimeUnixNano", type: "fixed64" },
  2: { name: "severityNumber", type: "uint32" },
  3: { name: "severityText", type: "string" },
  5: { name: "body", type: ANY_VALUE },
  6: ATTRIBUTES,
  7: { name: "droppedAttributesCount", type: "uint32" },
  8: { name: "flags", type: "fixed32" },
  9: { name: "traceId", type: "hex" },
  10: { name: "spanId", type: "hex" },
  12: { name: "eventName", type: "string" },
};
const SCOPE_LOGS: Schema = {
  1: { name: "scope", type: SCOPE },
  2: { name: "logRecords", type: LOG_RECORD, repeated: true },
  3: { name: "schemaUrl", type: "string" },
};
const RESOURCE_LOGS: Schema = {
  1: { name: "resource", type: RESOURCE },
  2: { name: "scopeLogs", type: SCOPE_LOGS, repeated: true },
  3: { name: "schemaUrl", type: "string" },
};
const EXPORT_LOGS_REQUEST: Schema = { 1: { name: "resourceLogs", type: RESOURCE_LOGS, repeated: true } };

const SPAN_EVENT: Schema = {
  1: { name: "timeUnixNano", type: "fixed64" },
  2: { name: "name", type: "string" },
  3: ATTRIBUTES,
  4: { name: "droppedAttributesCount", type: "uint32" },
};
const SPAN_LINK: Schema = {
  1: { name: "traceId", type: "hex" },
  2: { name: "spanId", type: "hex" },
  3: { name: "traceState", type: "string" },
  4: ATTRIBUTES,
  5: { name: "droppedAttributesCount", type: "uint32" },
  6: { name: "flags", type: "fixed32" },
};
const SPAN_STATUS: Schema = { 2: { name: "message", type: "string" }, 3: { name: "code", type: "uint32" } };
const SPAN: Schema = {
  1: { name: "traceId", type: "hex" },
  2: { name: "spanId", type: "hex" },
  3: { name: "traceState", type: "string" },
  4: { name: "parentSpanId", type: "hex" },
  16: { name: "flags", type: "fixed32" },
  5: { name: "name", type: "string" },
  6: { name: "kind", type: "uint32" },
  7: { name: "startTimeUnixNano", type: "fixed64" },
  8: { name: "endTimeUnixNano", type: "fixed64" },
  9: ATTRIBUTES,
  10: { name: "droppedAttributesCount", type: "uint32" },
  11: { name: "events", type: SPAN_EVENT, repeated: true },
  12: { name: "droppedEventsCount", type: "uint32" },
  13: { name: "links", type: SPAN_LINK, repeated: true },
  14: { name: "droppedLinksCount", type: "uint32" },
  15: { name: "status", type: SPAN_STATUS },
};
const SCOPE_SPANS: Schema = {
  1: { name: "scope", type: SCOPE },
  2: { name: "spans", type: SPAN, repeated: true },
  3: { name: "schemaUrl", type: "string" },
};
const RESOURCE_SPANS: Schema = {
  1: { name: "resource", type: RESOURCE },
  2: { name: "scopeSpans", type: SCOPE_SPANS, repeated: true },
  3: { name: "schemaUrl", type: "string" },
};
const EXPORT_TRACE_REQUEST: Schema = { 1: { name: "resourceSpans", type: RESOURCE_SPANS, repeated: true } };

/** Decodes an ExportLogsServiceRequest. Throws on malformed protobuf. */
export function decodeOtlpLogsProto(bytes: Uint8Array): Record<string, unknown> {
  return decodeMessage(bytes, EXPORT_LOGS_REQUEST);
}

/** Decodes an ExportTraceServiceRequest. Throws on malformed protobuf. */
export function decodeOtlpTracesProto(bytes: Uint8Array): Record<string, unknown> {
  return decodeMessage(bytes, EXPORT_TRACE_REQUEST);
}

const MAX_DEPTH = 64;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeMessage(bytes: Uint8Array, schema: Schema, depth = 0): Record<string, unknown> {
  if (depth > MAX_DEPTH) {
    throw new Error("protobuf nested too deeply");
  }
  const out: Record<string, unknown> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field < 1) {
      throw new Error("invalid protobuf field number");
    }
    const spec = schema[field];
    const raw = readRaw(bytes, offset, wire);
    offset = raw.next;
    if (spec === undefined) {
      continue;
    }
    const value = convert(raw, wire, spec.type, depth);
    if (spec.repeated) {
      const list = (out[spec.name] as unknown[] | undefined) ?? [];
      list.push(value);
      out[spec.name] = list;
    } else if (typeof spec.type === "object" && isRecord(value)) {
      // proto3: a repeated occurrence of a singular message field merges.
      const previous = out[spec.name];
      out[spec.name] = isRecord(previous) ? { ...previous, ...value } : value;
    } else {
      out[spec.name] = value;
    }
  }
  return out;
}

type Raw = { next: number; varint?: bigint; bytes?: Uint8Array };

function readRaw(bytes: Uint8Array, offset: number, wire: number): Raw {
  if (wire === WIRE_VARINT) {
    const v = readVarint(bytes, offset);
    return { next: v.next, varint: v.value };
  }
  if (wire === WIRE_I64 || wire === WIRE_I32) {
    const size = wire === WIRE_I64 ? 8 : 4;
    if (offset + size > bytes.length) {
      throw new Error("truncated protobuf fixed-width field");
    }
    return { next: offset + size, bytes: bytes.subarray(offset, offset + size) };
  }
  if (wire === WIRE_LEN) {
    const len = readVarint(bytes, offset);
    const end = len.next + Number(len.value);
    if (len.value > BigInt(bytes.length) || end > bytes.length) {
      throw new Error("truncated protobuf length-delimited field");
    }
    return { next: end, bytes: bytes.subarray(len.next, end) };
  }
  throw new Error(`unsupported protobuf wire type ${wire}`);
}

function convert(raw: Raw, wire: number, type: FieldType, depth: number): unknown {
  if (typeof type === "object") {
    return decodeMessage(expectBytes(raw, wire, WIRE_LEN), type, depth + 1);
  }
  switch (type) {
    case "string":
      return utf8.decode(expectBytes(raw, wire, WIRE_LEN));
    case "hex":
      return Buffer.from(expectBytes(raw, wire, WIRE_LEN)).toString("hex");
    case "base64":
      return Buffer.from(expectBytes(raw, wire, WIRE_LEN)).toString("base64");
    case "uint32":
      return Number(BigInt.asUintN(32, expectVarint(raw, wire)));
    case "int64":
      return BigInt.asIntN(64, expectVarint(raw, wire)).toString();
    case "bool":
      return expectVarint(raw, wire) !== 0n;
    case "fixed32":
      return view(expectBytes(raw, wire, WIRE_I32)).getUint32(0, true);
    case "fixed64":
      return view(expectBytes(raw, wire, WIRE_I64)).getBigUint64(0, true).toString();
    case "double":
      return view(expectBytes(raw, wire, WIRE_I64)).getFloat64(0, true);
  }
}

function expectVarint(raw: Raw, wire: number): bigint {
  if (wire !== WIRE_VARINT || raw.varint === undefined) {
    throw new Error("protobuf wire type mismatch");
  }
  return raw.varint;
}

function expectBytes(raw: Raw, wire: number, want: number): Uint8Array {
  if (wire !== want || raw.bytes === undefined) {
    throw new Error("protobuf wire type mismatch");
  }
  return raw.bytes;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < bytes.length && shift < 70n; i += 1) {
    const byte = bytes[i] ?? 0;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: i + 1 };
    }
    shift += 7n;
  }
  throw new Error("truncated protobuf varint");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
