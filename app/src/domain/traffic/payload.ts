import { splitGrpcFrames } from "./grpc-frames.ts";
import { decodeProtobufRaw } from "./protobuf-raw.ts";
import { isEventStreamContentType, splitSseFrames } from "./sse-frames.ts";
import type { TrafficPayload } from "./types.ts";

const JSON_PRETTY_SPACE = 2;

export type GrpcTrafficPayloadOpts = {
  omitted?: boolean;
  truncated?: boolean;
  contentType?: string;
  messages?: Uint8Array[];
  decoded?: unknown;
  decode?: boolean;
};

type HttpTrafficPayloadOpts = {
  omitted?: boolean;
  truncated?: boolean;
  // Replace the decoded text view (OpenAI-assembled SSE JSON). The tee still
  // supplied `body`; only the stored `text` changes.
  text?: string;
  // Generic text/event-stream: store a JSON array of blank-line-delimited frames.
  sseFrames?: boolean;
};

export function httpTrafficPayload(
  body: Buffer | undefined,
  contentType: string,
  opts: HttpTrafficPayloadOpts,
): TrafficPayload {
  if (opts.omitted) {
    return { omitted: true, truncated: opts.truncated, contentType: nonempty(contentType) };
  }
  if (!body || body.length === 0) {
    return { contentType: nonempty(contentType), truncated: opts.truncated };
  }
  if (opts.text !== undefined) {
    return {
      contentType: nonempty(contentType),
      encoding: "utf8",
      text: opts.text,
      truncated: opts.truncated,
    };
  }
  if (opts.sseFrames && isEventStreamContentType(contentType)) {
    return {
      contentType: nonempty(contentType) ?? "text/event-stream",
      encoding: "utf8",
      text: JSON.stringify(splitSseFrames(body.toString("utf8")), null, JSON_PRETTY_SPACE),
      truncated: opts.truncated,
    };
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
  opts: GrpcTrafficPayloadOpts,
): TrafficPayload {
  if (opts.omitted) {
    return { omitted: true, truncated: opts.truncated, contentType: "application/grpc", encoding: "base64" };
  }
  if (!body || body.length === 0) {
    return { contentType: "application/grpc", encoding: "base64", truncated: opts.truncated };
  }
  const split = splitGrpcFrames(body);
  const truncated = Boolean(opts.truncated || split.truncated);
  const payload: TrafficPayload = {
    contentType: "application/grpc",
    encoding: "base64",
    data: body.toString("base64"),
    truncated,
  };
  if (opts.decode === false) {
    return payload;
  }
  const text = formatDecoded(
    opts.decoded !== undefined
      ? opts.decoded
      : decodeGrpcBodies(messagesForDecode(opts.messages, split.frames), opts.contentType ?? ""),
  );
  if (text !== undefined) {
    payload.text = text;
  }
  return payload;
}

function messagesForDecode(
  provided: Uint8Array[] | undefined,
  frames: { compressed: boolean; message: Uint8Array }[],
): Uint8Array[] {
  if (provided) {
    return provided;
  }
  if (frames.some((frame) => frame.compressed)) {
    return [];
  }
  return frames.map((frame) => frame.message);
}

export function prettyGrpcMessage(frames: Buffer, contentType = ""): string | undefined {
  const split = splitGrpcFrames(frames);
  if (split.frames.some((frame) => frame.compressed)) {
    return undefined;
  }
  return formatDecoded(decodeGrpcBodies(split.frames.map((frame) => frame.message), contentType));
}

function decodeGrpcBodies(messages: Uint8Array[], contentType: string): unknown | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  const decoded: unknown[] = [];
  for (const message of messages) {
    const value = decodeGrpcBody(message, contentType);
    if (value === undefined) {
      continue;
    }
    decoded.push(value);
  }
  if (decoded.length === 0) {
    return undefined;
  }
  return decoded.length === 1 ? decoded[0] : decoded;
}

function decodeGrpcBody(message: Uint8Array, contentType: string): unknown | undefined {
  if (isGrpcJson(contentType, message)) {
    try {
      return JSON.parse(new TextDecoder().decode(message)) as unknown;
    } catch {
      // Fall through to decode_raw when the JSON content-type is wrong or truncated.
    }
  }
  return decodeProtobufRaw(message);
}

function isGrpcJson(contentType: string, message: Uint8Array): boolean {
  return contentType.toLowerCase().includes("grpc+json") || looksLikeJsonBytes(message);
}

function formatDecoded(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value, null, JSON_PRETTY_SPACE);
  } catch {
    return undefined;
  }
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

function looksLikeJsonBytes(body: Uint8Array): boolean {
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
