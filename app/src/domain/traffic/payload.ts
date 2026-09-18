import type { TrafficPayload } from "./types.ts";

const GRPC_PREFIX_BYTES = 5;
const JSON_PRETTY_SPACE = 2;

export function httpTrafficPayload(
  body: Buffer | undefined,
  contentType: string,
  opts: { omitted?: boolean; truncated?: boolean },
): TrafficPayload {
  if (opts.omitted) {
    return { omitted: true, truncated: opts.truncated, contentType: nonempty(contentType) };
  }
  if (!body || body.length === 0) {
    return { contentType: nonempty(contentType), truncated: opts.truncated };
  }
  if (looksLikeJsonBytes(body) || contentType.toLowerCase().includes("json")) {
    return {
      contentType: nonempty(contentType) ?? "application/json",
      encoding: "utf8",
      text: prettyUtf8(body),
      truncated: opts.truncated,
    };
  }
  if (isMostlyText(body)) {
    return {
      contentType: nonempty(contentType),
      encoding: "utf8",
      text: body.toString("utf8"),
      truncated: opts.truncated,
    };
  }
  return {
    contentType: nonempty(contentType),
    encoding: "base64",
    data: body.toString("base64"),
    truncated: opts.truncated,
  };
}

export function grpcTrafficPayload(
  body: Buffer | undefined,
  opts: { omitted?: boolean; truncated?: boolean },
): TrafficPayload {
  if (opts.omitted) {
    return { omitted: true, truncated: opts.truncated, contentType: "application/grpc", encoding: "base64" };
  }
  if (!body || body.length === 0) {
    return { contentType: "application/grpc", encoding: "base64", truncated: opts.truncated };
  }
  return {
    contentType: "application/grpc",
    encoding: "base64",
    data: body.toString("base64"),
    text: prettyGrpcMessage(body),
    truncated: opts.truncated,
  };
}

function prettyUtf8(body: Buffer): string {
  const raw = body.toString("utf8");
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return raw;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown, null, JSON_PRETTY_SPACE);
  } catch {
    return raw;
  }
}

export function prettyGrpcMessage(frames: Buffer): string | undefined {
  if (frames.length <= GRPC_PREFIX_BYTES) {
    return undefined;
  }
  const message = frames.subarray(GRPC_PREFIX_BYTES);
  if (!looksLikeJsonBytes(message)) {
    return undefined;
  }
  try {
    return JSON.stringify(JSON.parse(message.toString("utf8")) as unknown, null, JSON_PRETTY_SPACE);
  } catch {
    return undefined;
  }
}

function looksLikeJsonBytes(body: Buffer): boolean {
  let i = 0;
  while (i < body.length && (body[i] === 0x20 || body[i] === 0x09 || body[i] === 0x0a || body[i] === 0x0d)) {
    i += 1;
  }
  const first = body[i];
  return first === 0x7b || first === 0x5b;
}

function isMostlyText(body: Buffer): boolean {
  const sample = body.subarray(0, Math.min(body.length, 512));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      continue;
    }
    if (byte < 0x20 || byte === 0x7f) {
      control += 1;
    }
  }
  return control === 0;
}

function nonempty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
