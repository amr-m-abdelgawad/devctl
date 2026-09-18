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
    data: payload.data === undefined ? undefined : detector.redactText(payload.data),
    contentType: payload.contentType === undefined ? undefined : detector.redactText(payload.contentType),
  };
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
