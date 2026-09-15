import {
  LLM_OPERATION_CHAT,
  LLM_OPERATION_COMPLETION,
  LLM_OPERATION_EMBEDDING,
  LLM_OPERATION_OTHER,
  LLM_STATUS_ERROR,
  LLM_STATUS_OK,
  type LlmCallIngest,
  type LlmOperation,
} from "../../domain/llm/llm.ts";
import { dropEmptyBody, firstNumber, firstString, isRecord, parseJsonish } from "./json.ts";

const HTTP_ERROR_MIN = 400;

export function mapLiteLlmSpendLogs(source: string, payload: unknown, capturePrompts: boolean): LlmCallIngest[] {
  return spendLogRows(payload).map((row) => mapSpendLogRow(source, row, capturePrompts));
}

function spendLogRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (!isRecord(payload)) {
    return [];
  }
  if (Array.isArray(payload.data)) {
    return payload.data.filter(isRecord);
  }
  if (Array.isArray(payload.logs)) {
    return payload.logs.filter(isRecord);
  }
  return [payload];
}

export function mapSpendLogRow(source: string, row: Record<string, unknown>, capturePrompts: boolean): LlmCallIngest {
  const id = firstString(row, ["request_id", "id", "call_id"]) || fallbackId(row);
  const callType = firstString(row, ["call_type", "callType"]);
  const start = firstTime(row, ["startTime", "start_time", "start"]);
  const end = firstTime(row, ["endTime", "end_time", "end"]);
  const durationMs = durationBetween(start, end);
  const messages = parseJsonish(row.messages ?? row.proxy_server_request);
  const response = parseJsonish(row.response);
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const statusCode = firstNumber(row, ["status_code", "statusCode"]);
  const errText = firstString(row, ["error", "exception", "traceback"]);
  const failed = errText !== "" || (statusCode !== undefined && statusCode >= HTTP_ERROR_MIN) || firstString(row, ["status"]).toLowerCase() === "failure";
  const ingest: LlmCallIngest = {
    id,
    source,
    sourceType: "litellm",
    timestamp: end || start || new Date().toISOString(),
    durationMs,
    status: failed ? LLM_STATUS_ERROR : LLM_STATUS_OK,
    error: errText === "" ? undefined : errText,
    model: firstString(row, ["model_group", "model", "requested_model"]) || "unknown",
    routedModel: optionalString(firstString(row, ["model", "model_id"])),
    vendor: optionalString(firstString(metadata, ["custom_llm_provider"])),
    operation: operationFor(callType),
    usage: usageOf(row),
    cost: firstNumber(row, ["spend", "response_cost", "cost"]),
    request: capturePrompts ? messages : undefined,
    response: capturePrompts ? dropEmptyBody(response) : undefined,
    attributes: {
      call_type: callType,
      api_base: firstString(row, ["api_base"]),
      user: firstString(row, ["user", "end_user"]),
      team_id: firstString(row, ["team_id"]),
      request_tags: row.request_tags ?? metadata.spend_logs_metadata ?? null,
      ...flattenRecord("metadata", metadata),
    },
    requestId: optionalString(firstString(row, ["request_id"])) || id,
    traceId: optionalString(firstString(row, ["trace_id", "traceId"])) || optionalString(stringAttr(metadata, "trace_id")),
  };
  return ingest;
}

function operationFor(callType: string): LlmOperation {
  const kind = callType.toLowerCase();
  if (kind.includes("embed")) {
    return LLM_OPERATION_EMBEDDING;
  }
  if (kind.includes("text_completion") || kind === "atext_completion") {
    return LLM_OPERATION_COMPLETION;
  }
  if (kind.includes("completion") || kind.includes("chat") || kind.includes("message") || kind.includes("response")) {
    return LLM_OPERATION_CHAT;
  }
  if (kind === "") {
    return LLM_OPERATION_CHAT;
  }
  return LLM_OPERATION_OTHER;
}

function usageOf(row: Record<string, unknown>): LlmCallIngest["usage"] {
  const prompt = firstNumber(row, ["prompt_tokens", "promptTokens"]);
  const completion = firstNumber(row, ["completion_tokens", "completionTokens"]);
  const total = firstNumber(row, ["total_tokens", "totalTokens"]);
  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function durationBetween(start: string, end: string): number | undefined {
  if (start === "" || end === "") {
    return undefined;
  }
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) {
    return undefined;
  }
  return b - a;
}

function firstTime(row: Record<string, unknown>, keys: string[]): string {
  const raw = firstString(row, keys);
  if (raw === "") {
    return "";
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return raw;
  }
  return new Date(ms).toISOString();
}

function flattenRecord(prefix: string, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isRecord(item)) {
      out[`${prefix}.${key}`] = item;
    }
  }
  return out;
}

function stringAttr(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function optionalString(value: string): string | undefined {
  return value === "" ? undefined : value;
}

function fallbackId(row: Record<string, unknown>): string {
  const stamp = firstString(row, ["startTime", "start_time", "endTime"]);
  const model = firstString(row, ["model", "model_group"]);
  return `litellm:${stamp}:${model}`;
}
