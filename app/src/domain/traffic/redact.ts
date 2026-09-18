import { Detector } from "../../shared/redaction.ts";
import { coerceAnyValue } from "../logs/any-value.ts";
import { redactAnyValue, redactAttributes } from "../logs/redact.ts";
import type { TrafficCall, TrafficPayload } from "./types.ts";

export function redactTrafficCall(detector: Detector, call: TrafficCall): TrafficCall {
  return {
    ...call,
    path: detector.redactText(call.path),
    caller: call.caller === undefined ? undefined : detector.redactText(call.caller),
    request: call.request === undefined ? undefined : redactPayload(detector, call.request),
    response: call.response === undefined ? undefined : redactPayload(detector, call.response),
    attributes: redactAttributes(detector, coerceRecord(call.attributes)),
  };
}

export function stripTrafficBodies<T extends { request?: TrafficPayload; response?: TrafficPayload }>(call: T): T {
  return { ...call, request: undefined, response: undefined };
}

function redactPayload(detector: Detector, payload: TrafficPayload): TrafficPayload {
  return {
    ...payload,
    text: payload.text === undefined ? undefined : redactBodyText(detector, payload.text),
    data: payload.data === undefined ? undefined : redactEncodedData(detector, payload.data, payload.encoding),
    contentType: payload.contentType === undefined ? undefined : detector.redactText(payload.contentType),
  };
}

function redactEncodedData(detector: Detector, data: string, encoding?: TrafficPayload["encoding"]): string {
  if (encoding === "utf8") {
    return redactBodyText(detector, data);
  }
  return redactBase64(detector, data);
}

function redactBase64(detector: Detector, data: string): string {
  const buf = Buffer.from(data, "base64");
  if (buf.length === 0) {
    return data;
  }
  const redacted = redactDecodedBytes(detector, buf);
  if (redacted.equals(buf)) {
    return data;
  }
  return redacted.toString("base64");
}

const GRPC_PREFIX_BYTES = 5;

function redactDecodedBytes(detector: Detector, buf: Buffer): Buffer {
  const asUtf8 = buf.toString("utf8");
  if (looksLikeJsonText(asUtf8)) {
    return Buffer.from(redactBodyText(detector, asUtf8), "utf8");
  }
  if (buf.length > GRPC_PREFIX_BYTES) {
    const message = buf.subarray(GRPC_PREFIX_BYTES).toString("utf8");
    if (looksLikeJsonText(message)) {
      const redacted = redactBodyText(detector, message);
      return Buffer.concat([buf.subarray(0, GRPC_PREFIX_BYTES), Buffer.from(redacted, "utf8")]);
    }
  }
  const binary = buf.toString("latin1");
  const redacted = detector.redactText(binary);
  return redacted === binary ? buf : Buffer.from(redacted, "latin1");
}

function looksLikeJsonText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function redactBodyText(detector: Detector, text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return JSON.stringify(redactAnyValue(detector, coerceAnyValue(parsed)));
    } catch {
      return detector.redactText(text);
    }
  }
  return detector.redactText(text);
}

function coerceRecord(value: Record<string, unknown>): Record<string, ReturnType<typeof coerceAnyValue>> {
  const out: Record<string, ReturnType<typeof coerceAnyValue>> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = coerceAnyValue(item);
  }
  return out;
}
