import { DEFAULT_LOG_PAGE_SIZE, MAX_LOG_PAGE_SIZE } from "./types.ts";

export function clampLogPageSize(limit?: number): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return DEFAULT_LOG_PAGE_SIZE;
  }
  return Math.min(limit as number, MAX_LOG_PAGE_SIZE);
}
