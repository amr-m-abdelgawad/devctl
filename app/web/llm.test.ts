import { describe, expect, test } from "bun:test";
import {
  isLlmBodyMode,
  llmCostLabel,
  llmEffectiveBodyMode,
  llmIsRawSchema,
  llmPathOf,
  llmSourceLabel,
  llmTokenLabel,
  llmTurns,
  llmTurnsMarkdown,
  prettyJson,
} from "./llm.ts";
import type { LlmCallRow } from "./types.ts";

function call(overrides: Partial<LlmCallRow> = {}): LlmCallRow {
  return {
    id: "req-1",
    source: "apigee-llm",
    source_type: "proxy",
    timestamp: "2026-01-01T12:34:56.000Z",
    status: "ok",
    model: "gpt-4o",
    operation: "chat",
    attributes: {},
    ...overrides,
  };
}

describe("web LLM transcript", () => {
  test("walks OpenAI chat messages then the assistant reply", () => {
    expect(llmTurns(call({
      request: { messages: [{ role: "user", content: "hi" }, { role: "system", content: "be brief" }] },
      response: { choices: [{ message: { role: "assistant", content: "yo" } }] },
    }))).toEqual([
      { role: "user", content: "hi" },
      { role: "system", content: "be brief" },
      { role: "assistant", content: "yo" },
    ]);
  });

  test("joins multimodal text parts and names tool calls", () => {
    expect(llmTurns(call({
      request: { messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "text", text: "here" }] }] },
      response: { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "search" } }] } }] },
    }))).toEqual([
      { role: "user", content: "look\nhere" },
      { role: "assistant", content: "tool search" },
    ]);
  });

  test("falls back to prompt completions and embedding input", () => {
    expect(llmTurns(call({
      request: { prompt: "complete me" },
      response: { choices: [{ text: "done" }] },
    }))).toEqual([
      { role: "user", content: "complete me" },
      { role: "assistant", content: "done" },
    ]);
    expect(llmTurns(call({ request: { input: "embed this" } }))).toEqual([
      { role: "user", content: "embed this" },
    ]);
  });

  test("returns no turns for proprietary JSON", () => {
    expect(llmTurns(call({ request: { contents: [{ text: "hi" }] }, response: { candidates: [{ text: "yo" }] } }))).toEqual([]);
  });

  test("formats markdown and forces json when there is no transcript", () => {
    const turns = [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }];
    expect(llmTurnsMarkdown(turns)).toBe("**user**\nhi\n\n**assistant**\nyo");
    expect(llmEffectiveBodyMode([], "conversation")).toBe("json");
    expect(llmEffectiveBodyMode(turns, "conversation")).toBe("conversation");
    expect(llmEffectiveBodyMode(turns, "json")).toBe("json");
    expect(isLlmBodyMode("json")).toBe(true);
    expect(isLlmBodyMode("raw")).toBe(false);
  });
});

describe("web LLM labels", () => {
  test("renders tokens, cost, via, and path", () => {
    expect(llmTokenLabel({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 })).toBe("16");
    expect(llmTokenLabel(undefined)).toBe("—");
    expect(llmCostLabel(0.0123)).toBe("$0.0123");
    expect(llmCostLabel(undefined)).toBe("—");
    expect(llmSourceLabel(call())).toBe("via");
    expect(llmPathOf(call({ attributes: { path: "/generations/v1alpha2", schema: "raw" } }))).toBe("/generations/v1alpha2");
    expect(llmIsRawSchema(call({ attributes: { schema: "raw" } }))).toBe(true);
    expect(prettyJson({ a: 1 })).toBe("{\n  \"a\": 1\n}");
  });
});
