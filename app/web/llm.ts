import { coerceJsonInput } from "./json-view.ts";
import type { LlmCallRow, LlmUsageRow } from "./types.ts";

export function prettyJson(value: unknown): string {
  return coerceJsonInput(value).pretty;
}

export type LlmTurn = {
  role: string;
  content: string;
};

export type LlmBodyMode = "conversation" | "json";

const BODY_MODES: readonly LlmBodyMode[] = ["conversation", "json"];

export function isLlmBodyMode(value: string): value is LlmBodyMode {
  return (BODY_MODES as readonly string[]).includes(value);
}

export function llmEffectiveBodyMode(turns: readonly LlmTurn[], preferred: LlmBodyMode): LlmBodyMode {
  return turns.length === 0 ? "json" : preferred;
}

export function llmTurns(call: Pick<LlmCallRow, "request" | "response">): LlmTurn[] {
  return [...turnsFromRequest(asRecord(call.request)), ...turnsFromResponse(asRecord(call.response))];
}

export function llmTurnsMarkdown(turns: readonly LlmTurn[]): string {
  return turns.map((turn) => `**${turn.role}**\n${turn.content}`).join("\n\n");
}

export function llmTokenTotal(usage?: LlmUsageRow): number {
  if (!usage) {
    return 0;
  }
  const total = usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0));
  return total > 0 ? total : 0;
}

export function llmTokenLabel(usage?: LlmUsageRow): string {
  const total = llmTokenTotal(usage);
  return total > 0 ? total.toLocaleString("en-US") : "—";
}

export function llmCostLabel(cost?: number): string {
  return cost === undefined ? "—" : `$${cost.toFixed(4)}`;
}

export function llmSourceLabel(call: Pick<LlmCallRow, "source" | "source_type">): string {
  return call.source_type === "proxy" ? "via" : "source";
}

export function llmSourceValue(call: Pick<LlmCallRow, "source" | "source_type">): string {
  return call.source_type === "proxy" ? `via ${call.source}` : call.source;
}

export function llmPathOf(call: Pick<LlmCallRow, "attributes">): string {
  const path = call.attributes?.path;
  return typeof path === "string" && path.trim() !== "" ? path : "";
}

export function llmIsRawSchema(call: Pick<LlmCallRow, "attributes">): boolean {
  return call.attributes?.schema === "raw";
}

export function llmIsStream(call: Pick<LlmCallRow, "attributes">): boolean {
  return call.attributes?.stream === true;
}

export function llmVisibleAttributes(call: Pick<LlmCallRow, "attributes">): Array<[string, string]> {
  return Object.entries(call.attributes ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, prettyJson(value)]);
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
  return input === "" ? [] : [{ role: "user", content: input }];
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
      return [{ role: namedRole(message.role, "assistant"), content }];
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
    return content === "" ? [] : [{ role: namedRole(rec.role, "user"), content }];
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

function namedRole(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
