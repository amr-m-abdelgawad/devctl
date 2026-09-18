import { describe, expect, test } from "bun:test";
import { LLM_OPERATION_CHAT, LLM_STATUS_OK, type LlmCall } from "../../../domain/llm/llm.ts";
import {
  clipLlmJson,
  formatLlmCaller,
  formatLlmClock,
  formatLlmStatus,
  formatLlmTokenBreakdown,
  formatLlmTokens,
  llmBodyModeHint,
  llmEffectiveBodyMode,
  llmIsRawSchema,
  llmListPaneWidth,
  llmModelColumnWidth,
  llmPathOf,
  llmPreview,
  llmRowShowsCaller,
  llmRowShowsTokens,
  llmSourceLabel,
  llmTurns,
  llmVisibleAttributes,
  toggleLlmBodyMode,
} from "./llm.ts";

function call(overrides: Partial<LlmCall> = {}): LlmCall {
  return {
    seq: 1,
    id: "req-1",
    source: "apigee-llm",
    sourceType: "proxy",
    timestamp: "2026-01-01T12:34:56.000Z",
    status: LLM_STATUS_OK,
    model: "gpt-4o",
    operation: LLM_OPERATION_CHAT,
    attributes: {},
    ...overrides,
  };
}

describe("LLM TUI formatters", () => {
  test("lists a compact total and details a prompt/completion split", () => {
    const usage = { promptTokens: 12, completionTokens: 4, totalTokens: 16 };
    expect(formatLlmTokens(usage)).toBe("16");
    expect(formatLlmTokenBreakdown(usage)).toBe("prompt 12  completion 4  total 16");
  });

  test("renders a dash when usage is missing", () => {
    expect(formatLlmTokens(undefined)).toBe("—");
    expect(formatLlmTokenBreakdown(undefined)).toBe("—");
    expect(formatLlmTokens({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })).toBe("—");
  });

  test("renders the originating service or a dash", () => {
    expect(formatLlmCaller("api")).toBe("api");
    expect(formatLlmCaller("")).toBe("—");
    expect(formatLlmCaller(undefined)).toBe("—");
  });

  test("compacts status and clock for the list", () => {
    expect(formatLlmStatus("ok")).toBe("ok");
    expect(formatLlmStatus("error")).toBe("err");
    expect(formatLlmClock("2026-01-01T12:34:56.000Z")).toBe("12:34:56");
  });
});

describe("LLM transcript", () => {
  test("walks OpenAI chat messages then the assistant reply", () => {
    const turns = llmTurns(call({
      request: { messages: [{ role: "user", content: "hi" }, { role: "system", content: "be brief" }] },
      response: { choices: [{ message: { role: "assistant", content: "yo" } }] },
    }));
    expect(turns).toEqual([
      { role: "user", content: "hi" },
      { role: "system", content: "be brief" },
      { role: "assistant", content: "yo" },
    ]);
  });

  test("joins multimodal text parts and names tool calls", () => {
    const turns = llmTurns(call({
      request: { messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "text", text: "here" }] }] },
      response: { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "search" } }] } }] },
    }));
    expect(turns).toEqual([
      { role: "user", content: "look\nhere" },
      { role: "assistant", content: "tool search" },
    ]);
  });

  test("falls back to prompt/text completions and embedding input", () => {
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

  test("returns no turns for a proprietary JSON body", () => {
    expect(llmTurns(call({ request: { contents: [{ text: "hi" }] }, response: { candidates: [{ text: "yo" }] } }))).toEqual([]);
  });

  test("previews the last user turn as one line", () => {
    expect(llmPreview(call({
      request: { messages: [{ role: "user", content: "hello\nworld" }] },
      response: { choices: [{ message: { role: "assistant", content: "ok" } }] },
    }))).toBe("hello world");
  });
});

describe("LLM list layout and attributes", () => {
  test("hides caller and tokens on a narrow pane", () => {
    expect(llmRowShowsTokens(40)).toBe(false);
    expect(llmRowShowsCaller(40)).toBe(false);
    expect(llmRowShowsTokens(50)).toBe(true);
    expect(llmRowShowsCaller(60)).toBe(true);
    expect(llmModelColumnWidth(40)).toBeGreaterThan(0);
  });

  test("caps the list pane so the inspector keeps room", () => {
    expect(llmListPaneWidth(80, true)).toBe(80);
    expect(llmListPaneWidth(200, false)).toBe(56);
    expect(llmListPaneWidth(90, false)).toBeGreaterThanOrEqual(40);
  });

  test("labels a proxy source as via and keeps path/raw flags", () => {
    const row = call({ attributes: { schema: "raw", path: "/generations/v1alpha2", capture: "proxy" } });
    expect(llmSourceLabel(row)).toBe("via");
    expect(llmPathOf(row)).toBe("/generations/v1alpha2");
    expect(llmIsRawSchema(row)).toBe(true);
    expect(llmVisibleAttributes(row).map(([key]) => key)).toContain("path");
  });

  test("clips oversized JSON for the inspector snapshot", () => {
    expect(clipLlmJson({ a: "x".repeat(80) }, 20).endsWith("…")).toBe(true);
  });
});

describe("LLM body mode", () => {
  test("toggles conversation and json", () => {
    expect(toggleLlmBodyMode("conversation")).toBe("json");
    expect(toggleLlmBodyMode("json")).toBe("conversation");
    expect(llmBodyModeHint("conversation")).toBe("json");
    expect(llmBodyModeHint("json")).toBe("conversation");
  });

  test("forces json when the call has no transcript", () => {
    expect(llmEffectiveBodyMode(call({ request: { contents: [] } }), "conversation")).toBe("json");
    expect(llmEffectiveBodyMode(call({
      request: { messages: [{ role: "user", content: "hi" }] },
    }), "conversation")).toBe("conversation");
    expect(llmEffectiveBodyMode(call({
      request: { messages: [{ role: "user", content: "hi" }] },
    }), "json")).toBe("json");
  });
});
