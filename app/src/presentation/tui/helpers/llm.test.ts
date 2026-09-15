import { describe, expect, test } from "bun:test";
import { formatLlmCaller, formatLlmTokenBreakdown, formatLlmTokens } from "./llm.ts";

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
});
