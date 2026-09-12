import type { SpanKind, SpanStatusCode } from "./types.ts";

const KIND_INTERNAL = 1;
const KIND_SERVER = 2;
const KIND_CLIENT = 3;
const KIND_PRODUCER = 4;
const KIND_CONSUMER = 5;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

export function spanKindFromOtlp(value: unknown): SpanKind {
  if (typeof value === "string") {
    const lower = value.replace(/^span_kind_/i, "").toLowerCase();
    if (lower === "server") return "server";
    if (lower === "client") return "client";
    if (lower === "producer") return "producer";
    if (lower === "consumer") return "consumer";
    return "internal";
  }
  if (value === KIND_SERVER) return "server";
  if (value === KIND_CLIENT) return "client";
  if (value === KIND_PRODUCER) return "producer";
  if (value === KIND_CONSUMER) return "consumer";
  if (value === KIND_INTERNAL) return "internal";
  return "internal";
}

export function spanStatusFromOtlp(value: unknown): { code: SpanStatusCode; message?: string } {
  if (typeof value !== "object" || value === null) {
    return { code: "unset" };
  }
  const rec = value as { code?: unknown; message?: unknown };
  const message = typeof rec.message === "string" && rec.message !== "" ? rec.message : undefined;
  if (rec.code === STATUS_ERROR || rec.code === "STATUS_CODE_ERROR" || rec.code === "error") {
    return { code: "error", message };
  }
  if (rec.code === STATUS_OK || rec.code === "STATUS_CODE_OK" || rec.code === "ok") {
    return { code: "ok", message };
  }
  return { code: "unset", message };
}
