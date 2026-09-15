import type { LlmUsage } from "../../../domain/llm/llm.ts";

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
