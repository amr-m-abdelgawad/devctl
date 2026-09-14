import { Detector } from "../../shared/redaction.ts";
import { coerceAnyValue } from "../logs/any-value.ts";
import { redactAnyValue, redactAttributes } from "../logs/redact.ts";
import type { LlmCall } from "./types.ts";

export function redactLlmCall(detector: Detector, call: LlmCall): LlmCall {
  return {
    ...call,
    error: call.error === undefined ? undefined : detector.redactText(call.error),
    model: detector.redactText(call.model),
    routedModel: call.routedModel === undefined ? undefined : detector.redactText(call.routedModel),
    request: call.request === undefined ? undefined : redactAnyValue(detector, coerceAnyValue(call.request)),
    response: call.response === undefined ? undefined : redactAnyValue(detector, coerceAnyValue(call.response)),
    attributes: redactAttributes(detector, coerceRecord(call.attributes)),
  };
}

export function stripLlmBodies<T extends { request?: unknown; response?: unknown }>(call: T): T {
  return { ...call, request: undefined, response: undefined };
}

function coerceRecord(value: Record<string, unknown>): Record<string, ReturnType<typeof coerceAnyValue>> {
  const out: Record<string, ReturnType<typeof coerceAnyValue>> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = coerceAnyValue(item);
  }
  return out;
}
