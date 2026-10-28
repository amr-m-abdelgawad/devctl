import { DEFAULT_LOG_PAGE_SIZE, MAX_LOG_PAGE_SIZE } from "./types.ts";

export function clampLogPageSize(limit?: number): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return DEFAULT_LOG_PAGE_SIZE;
  }
  return Math.min(limit as number, MAX_LOG_PAGE_SIZE);
}

/** Position in one daemon session's log sequence. Opaque to clients except for gap filling. */
export type LogCursor = { session: string; seq: number };

export function encodeLogCursor(c: LogCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeLogCursor(raw: string): LogCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { session?: unknown }).session === "string" &&
      typeof (parsed as { seq?: unknown }).seq === "number"
    ) {
      return parsed as LogCursor;
    }
  } catch {
    // malformed cursor — treated as absent by callers
  }
  return undefined;
}
