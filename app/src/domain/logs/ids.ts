export const TRACE_ID_HEX_LENGTH = 32;
export const SPAN_ID_HEX_LENGTH = 16;
export const TRACEPARENT_VERSION = "00";
export const REQUEST_ID_ATTR = "devctl.request_id";

const HEX = "0123456789abcdef";

export function isTraceId(value: string): boolean {
  return isHex(value, TRACE_ID_HEX_LENGTH);
}

export function isSpanId(value: string): boolean {
  return isHex(value, SPAN_ID_HEX_LENGTH);
}

export function generateTraceId(): string {
  return randomHex(TRACE_ID_HEX_LENGTH / 2);
}

export function generateSpanId(): string {
  return randomHex(SPAN_ID_HEX_LENGTH / 2);
}

export type TraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
};

export function parseTraceparent(header: string): TraceContext | undefined {
  const parts = header.trim().split("-");
  if (parts.length !== 4) {
    return undefined;
  }
  const [version, traceId, parentSpanId, flags] = parts;
  if (version !== TRACEPARENT_VERSION || !traceId || !parentSpanId || !flags) {
    return undefined;
  }
  if (!isTraceId(traceId) || !isSpanId(parentSpanId) || !/^[0-9a-f]{2}$/i.test(flags)) {
    return undefined;
  }
  return {
    traceId: traceId.toLowerCase(),
    spanId: generateSpanId(),
    parentSpanId: parentSpanId.toLowerCase(),
    traceFlags: Number.parseInt(flags, 16),
  };
}

export function formatTraceparent(ctx: TraceContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `${TRACEPARENT_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

export function startServerSpanContext(input: { traceparent?: string; requestId?: string }): TraceContext & { requestId: string } {
  if (input.traceparent) {
    const parsed = parseTraceparent(input.traceparent);
    if (parsed) {
      const requestId = input.requestId && input.requestId !== "" ? input.requestId : parsed.traceId;
      return { ...parsed, requestId };
    }
  }
  // Only a real W3C traceparent (handled above) may set the trace id. A bare
  // X-Devctl-Request-ID is never adopted as the trace id, even when it happens
  // to be 32 hex chars — otherwise two unrelated requests that reuse or collide
  // on such a value would be merged into one trace. The request id is still
  // preserved for request-based lookup.
  const incoming = (input.requestId ?? "").trim();
  const traceId = generateTraceId();
  return {
    traceId,
    spanId: generateSpanId(),
    traceFlags: 1,
    requestId: incoming === "" ? traceId : incoming,
  };
}

function isHex(value: string, length: number): boolean {
  if (value.length !== length) {
    return false;
  }
  return /^[0-9a-f]+$/i.test(value);
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0xf];
    out += HEX[byte & 0xf];
  }
  return out;
}
