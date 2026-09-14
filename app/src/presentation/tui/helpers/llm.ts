import type { LlmUsage } from "../../../domain/llm/llm.ts";

export function formatLlmTokens(usage?: LlmUsage): string {
  if (!usage) {
    return "—";
  }
  const total = usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0));
  return total > 0 ? String(total) : "—";
}

export function formatLlmCost(cost?: number): string {
  return cost === undefined ? "—" : `$${cost.toFixed(4)}`;
}

const MS_PER_SECOND = 1000;

export function formatLlmDuration(ms?: number): string {
  if (ms === undefined) {
    return "—";
  }
  if (ms >= MS_PER_SECOND) {
    return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  }
  return `${ms}ms`;
}

export function formatLlmJson(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
