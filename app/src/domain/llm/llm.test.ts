import { describe, expect, test } from "bun:test";
import { Detector, REDACTED_VALUE } from "../../shared/redaction.ts";
import { matchesLlmCall } from "./match.ts";
import { redactLlmCall, stripLlmBodies } from "./redact.ts";
import { LLM_OPERATION_CHAT, LLM_STATUS_ERROR, LLM_STATUS_OK, clampLlmPageSize, estimateLlmCost, normalizeLlmPathPrefix, type LlmCall } from "./types.ts";

function call(overrides: Partial<LlmCall> = {}): LlmCall {
  return {
    seq: 1,
    id: "chatcmpl-1",
    source: "platform",
    sourceType: "litellm",
    timestamp: "2026-01-01T00:00:00.000Z",
    status: LLM_STATUS_OK,
    model: "gpt-4o",
    operation: LLM_OPERATION_CHAT,
    attributes: {},
    ...overrides,
  };
}

describe("llm domain", () => {
  test("normalizes path prefixes and page sizes", () => {
    expect(normalizeLlmPathPrefix("/llm/")).toBe("llm");
    expect(normalizeLlmPathPrefix("")).toBe("");
    expect(clampLlmPageSize(undefined)).toBe(100);
    expect(clampLlmPageSize(9_000)).toBe(500);
  });

  test("matches filters including search over request bodies", () => {
    const row = call({ request: { messages: [{ role: "user", content: "hello secret" }] }, requestId: "req-1", caller: "worker" });
    expect(matchesLlmCall({ source: "platform", model: "gpt-4o" }, row)).toBe(true);
    expect(matchesLlmCall({ status: LLM_STATUS_ERROR }, row)).toBe(false);
    expect(matchesLlmCall({ search: "hello" }, row)).toBe(true);
    expect(matchesLlmCall({ search: "worker" }, row)).toBe(true);
    expect(matchesLlmCall({ caller: "worker" }, row)).toBe(true);
    expect(matchesLlmCall({ caller: "api" }, row)).toBe(false);
    expect(matchesLlmCall({ requestId: "req-1" }, row)).toBe(true);
  });

  test("caller '-' selects only calls with no caller", () => {
    const attributed = call({ caller: "worker" });
    const unattributed = call({ caller: undefined });
    const blank = call({ caller: "  " });
    expect(matchesLlmCall({ caller: "-" }, attributed)).toBe(false);
    expect(matchesLlmCall({ caller: "-" }, unattributed)).toBe(true);
    expect(matchesLlmCall({ caller: "-" }, blank)).toBe(true);
    // A named filter never matches an unattributed call.
    expect(matchesLlmCall({ caller: "worker" }, unattributed)).toBe(false);
  });

  test("redacts secrets in bodies and attributes and can drop bodies", () => {
    const detector = new Detector(["api_key"], []);
    const redacted = redactLlmCall(detector, call({
      request: { api_key: "sk-live", messages: [{ content: "ok" }] },
      attributes: { authorization: "Bearer hunter2" },
      error: "token=abcd",
    }));
    expect(JSON.stringify(redacted)).not.toContain("sk-live");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(redacted.attributes.authorization).toBe(REDACTED_VALUE);
    expect(stripLlmBodies(redacted).request).toBeUndefined();
  });

  test("keeps usage and max_tokens counts in redacted bodies", () => {
    const detector = new Detector([], []);
    const redacted = redactLlmCall(detector, call({
      request: { model: "gpt-4o", max_tokens: 256, messages: [{ role: "user", content: "hi" }] },
      response: { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
      usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
    }));
    expect(redacted.request).toEqual({ model: "gpt-4o", max_tokens: 256, messages: [{ role: "user", content: "hi" }] });
    expect(redacted.response).toEqual({ usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
    expect(redacted.usage).toEqual({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
  });

  test("estimateLlmCost is undefined when usage or rates are missing", () => {
    const rates = { input: 0.001, output: 0.002 };
    expect(estimateLlmCost(undefined, rates)).toBeUndefined();
    expect(estimateLlmCost({ totalTokens: 10 }, rates)).toBeUndefined();
    expect(estimateLlmCost({ promptTokens: 3 }, rates)).toBeUndefined();
    expect(estimateLlmCost({ completionTokens: 2 }, rates)).toBeUndefined();
    expect(estimateLlmCost({ promptTokens: 3, completionTokens: 2 }, undefined)).toBeUndefined();
  });

  test("estimateLlmCost is the product sum when both token counts and rates are present", () => {
    expect(estimateLlmCost({ promptTokens: 3, completionTokens: 2, totalTokens: 5 }, { input: 0.001, output: 0.002 })).toBe(0.007);
    expect(estimateLlmCost({ promptTokens: 0, completionTokens: 0 }, { input: 1, output: 1 })).toBe(0);
  });
});
