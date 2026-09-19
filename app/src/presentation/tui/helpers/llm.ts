import type { LlmCall, LlmUsage } from "../../../domain/llm/llm.ts";
import { coerceJsonInput } from "../../../shared/json-view.ts";

export const LLM_CURSOR_COL = 2;
export const LLM_TIME_COL = 9;
export const LLM_STATUS_COL = 4;
export const LLM_CALLER_COL = 12;
export const LLM_LAT_COL = 7;
export const LLM_TOK_COL = 6;
export const LLM_LIST_MIN = 40;
export const LLM_LIST_MAX = 56;
export const LLM_DETAIL_MIN = 36;
export const LLM_INSPECTOR_JSON_CHARS = 1_600;
export const LLM_INSPECTOR_TURNS = 6;

const LIST_PANE_RATIO = 0.42;
const SHOW_CALLER_AT = 52;
const SHOW_TOKENS_AT = 44;
const MS_PER_SECOND = 1_000;
const CLOCK_START = 11;
const CLOCK_END = 19;

export type LlmTurn = {
  role: string;
  content: string;
};

export type LlmBodyMode = "conversation" | "json";

export function toggleLlmBodyMode(mode: LlmBodyMode): LlmBodyMode {
  return mode === "json" ? "conversation" : "json";
}

export function llmEffectiveBodyMode(call: LlmCall, preferred: LlmBodyMode): LlmBodyMode {
  return llmTurns(call).length === 0 ? "json" : preferred;
}

export function llmBodyModeHint(mode: LlmBodyMode): string {
  return mode === "json" ? "conversation" : "json";
}

export function formatLlmTokens(usage?: LlmUsage): string {
  const total = llmTokenTotal(usage);
  return total === undefined ? "—" : String(total);
}

export function formatLlmTokenBreakdown(usage?: LlmUsage): string {
  if (!usage) {
    return "—";
  }
  const parts: string[] = [];
  if (usage.promptTokens !== undefined) {
    parts.push(`prompt ${usage.promptTokens}`);
  }
  if (usage.completionTokens !== undefined) {
    parts.push(`completion ${usage.completionTokens}`);
  }
  const total = llmTokenTotal(usage);
  if (total !== undefined) {
    parts.push(`total ${total}`);
  }
  return parts.length > 0 ? parts.join("  ") : "—";
}

function llmTokenTotal(usage?: LlmUsage): number | undefined {
  if (!usage) {
    return undefined;
  }
  const total = usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0));
  return total > 0 ? total : undefined;
}

export function formatLlmCaller(caller?: string): string {
  return caller && caller.trim() !== "" ? caller : "—";
}

export function formatLlmCost(cost?: number): string {
  return cost === undefined ? "—" : `$${cost.toFixed(4)}`;
}

export function formatLlmDuration(ms?: number): string {
  if (ms === undefined) {
    return "—";
  }
  if (ms >= MS_PER_SECOND) {
    return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  }
  return `${ms}ms`;
}

export function formatLlmClock(timestamp: string): string {
  const clock = timestamp.slice(CLOCK_START, CLOCK_END);
  return clock === "" ? timestamp : clock;
}

export function formatLlmStatus(status: LlmCall["status"]): string {
  return status === "error" ? "err" : "ok";
}

export function formatLlmJson(value: unknown): string {
  return coerceJsonInput(value).pretty;
}

export function clipLlmJson(value: unknown, maxChars: number): string {
  const text = formatLlmJson(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function llmSourceLabel(call: LlmCall): string {
  return call.sourceType === "proxy" ? "via" : "source";
}

export function llmSourceValue(call: LlmCall): string {
  return `${call.source} (${call.sourceType})`;
}

export function llmRowShowsCaller(paneWidth: number): boolean {
  return paneWidth >= SHOW_CALLER_AT;
}

export function llmRowShowsTokens(paneWidth: number): boolean {
  return paneWidth >= SHOW_TOKENS_AT;
}

export function llmModelColumnWidth(paneWidth: number): number {
  let used = LLM_CURSOR_COL + LLM_TIME_COL + LLM_STATUS_COL + LLM_LAT_COL;
  if (llmRowShowsCaller(paneWidth)) {
    used += LLM_CALLER_COL;
  }
  if (llmRowShowsTokens(paneWidth)) {
    used += LLM_TOK_COL;
  }
  return Math.max(8, paneWidth - used);
}

export function llmListPaneWidth(termWidth: number, stacked: boolean): number {
  if (stacked) {
    return termWidth;
  }
  return Math.min(LLM_LIST_MAX, Math.max(LLM_LIST_MIN, Math.floor(termWidth * LIST_PANE_RATIO)));
}

export function llmTurns(call: LlmCall): LlmTurn[] {
  const requestTurns = turnsFromRequest(asRecord(call.request));
  const responseTurns = turnsFromResponse(asRecord(call.response));
  return [...requestTurns, ...responseTurns];
}

export function llmPreview(call: LlmCall): string {
  const turns = llmTurns(call);
  const lastUser = [...turns].reverse().find((turn) => turn.role === "user");
  if (lastUser) {
    return oneLine(lastUser.content);
  }
  const last = turns[turns.length - 1];
  return last ? oneLine(last.content) : "";
}

export function llmVisibleAttributes(call: LlmCall): Array<[string, string]> {
  return Object.entries(call.attributes)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, formatLlmJson(value)] as [string, string]);
}

export function llmPathOf(call: LlmCall): string {
  const path = call.attributes.path;
  return typeof path === "string" && path.trim() !== "" ? path : "";
}

export function llmIsRawSchema(call: LlmCall): boolean {
  return call.attributes.schema === "raw";
}

export function llmIsStream(call: LlmCall): boolean {
  return call.attributes.stream === true;
}

function turnsFromRequest(request: Record<string, unknown> | undefined): LlmTurn[] {
  if (!request) {
    return [];
  }
  const fromMessages = turnsFromMessages(request.messages);
  if (fromMessages.length > 0) {
    return fromMessages;
  }
  if (typeof request.prompt === "string" && request.prompt.trim() !== "") {
    return [{ role: "user", content: request.prompt }];
  }
  const input = embeddingInput(request.input);
  if (input !== "") {
    return [{ role: "user", content: input }];
  }
  return [];
}

function turnsFromResponse(response: Record<string, unknown> | undefined): LlmTurn[] {
  if (!response) {
    return [];
  }
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = asRecord(choices[0]);
  if (!first) {
    return [];
  }
  const message = asRecord(first.message);
  if (message) {
    const content = messageContent(message.content) || toolCallSummary(message);
    if (content !== "") {
      return [{ role: roleOf(message.role, "assistant"), content }];
    }
  }
  if (typeof first.text === "string" && first.text.trim() !== "") {
    return [{ role: "assistant", content: first.text }];
  }
  return [];
}

function turnsFromMessages(raw: unknown): LlmTurn[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    const rec = asRecord(item);
    if (!rec) {
      return [];
    }
    const content = messageContent(rec.content) || toolCallSummary(rec);
    if (content === "") {
      return [];
    }
    return [{ role: roleOf(rec.role, "user"), content }];
  });
}

function toolCallSummary(message: Record<string, unknown>): string {
  if (!Array.isArray(message.tool_calls)) {
    return "";
  }
  const names = message.tool_calls.flatMap((entry) => {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    return name === "" ? [] : [name];
  });
  return names.length === 0 ? "" : `tool ${names.join(", ")}`;
}

function messageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const rec = asRecord(part);
      return typeof rec?.text === "string" ? rec.text : "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

function embeddingInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => (typeof item === "string" ? item : ""))
    .filter((item) => item !== "")
    .join("\n");
}

function roleOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
