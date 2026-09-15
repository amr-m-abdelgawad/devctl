import { DEFAULT_LLM_POLL_SECONDS } from "../config/types.ts";

export const LLM_OPERATION_CHAT = "chat";
export const LLM_OPERATION_COMPLETION = "completion";
export const LLM_OPERATION_EMBEDDING = "embedding";
export const LLM_OPERATION_OTHER = "other";

export type LlmOperation =
  | typeof LLM_OPERATION_CHAT
  | typeof LLM_OPERATION_COMPLETION
  | typeof LLM_OPERATION_EMBEDDING
  | typeof LLM_OPERATION_OTHER;

export const LLM_STATUS_OK = "ok";
export const LLM_STATUS_ERROR = "error";

export type LlmCallStatus = typeof LLM_STATUS_OK | typeof LLM_STATUS_ERROR;

export const DEFAULT_LLM_PAGE_SIZE = 100;
export const MAX_LLM_PAGE_SIZE = 500;
export const DEFAULT_LLM_STORE_CAP = 2_000;

export type LlmUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type LlmCall = {
  seq: number;
  id: string;
  source: string;
  sourceType: string;
  timestamp: string;
  durationMs?: number;
  status: LlmCallStatus;
  error?: string;
  model: string;
  routedModel?: string;
  vendor?: string;
  operation: LlmOperation;
  caller?: string;
  usage?: LlmUsage;
  cost?: number;
  request?: unknown;
  response?: unknown;
  attributes: Record<string, unknown>;
  requestId?: string;
  traceId?: string;
};

export type LlmCallIngest = Omit<LlmCall, "seq">;

export type LlmCallFilter = {
  source?: string;
  sourceType?: string;
  model?: string;
  caller?: string;
  status?: LlmCallStatus;
  search?: string;
  since?: string;
  until?: string;
  requestId?: string;
  traceId?: string;
};

export type LlmCallPageRequest = {
  cursor?: string;
  limit?: number;
};

export type LlmCallPage = {
  calls: LlmCall[];
  nextCursor: string;
  hasNext: boolean;
  errors: LlmSourceError[];
};

export type LlmCallFacets = {
  total: number;
  errors: number;
  bySource: Record<string, number>;
  byModel: Record<string, number>;
  byStatus: Record<string, number>;
};

export type LlmSourceCapabilities = {
  hasBodies: boolean;
  hasCost: boolean;
  hasUsage: boolean;
  liveQuery: boolean;
};

export type LlmSourceError = {
  source: string;
  message: string;
  status?: number;
};

export function clampLlmPageSize(limit?: number): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return DEFAULT_LLM_PAGE_SIZE;
  }
  return Math.min(limit as number, MAX_LLM_PAGE_SIZE);
}

export function normalizeLlmPathPrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, "");
}

export function llmPollSeconds(value: number): number {
  return value > 0 ? value : DEFAULT_LLM_POLL_SECONDS;
}
