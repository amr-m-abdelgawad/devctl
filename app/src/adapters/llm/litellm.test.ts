import { describe, expect, test } from "bun:test";
import { mapLiteLlmSpendLogs } from "./litellm-map.ts";
import { joinLlmUrl, litellmDriver, LlmSourceHttpError, spendLogsUrl } from "./litellm.ts";
import { emptyLlmSource } from "../../domain/config/types.ts";
import { LLM_OPERATION_CHAT, LLM_STATUS_ERROR, LLM_STATUS_OK } from "../../domain/llm/llm.ts";

const sample = {
  request_id: "chatcmpl-9ZKMURhVYSi9D6r6PJ9vLcayIK0Vm",
  call_type: "acompletion",
  model_group: "llama3",
  model: "llama3-70b",
  spend: 0.000002,
  total_tokens: 100,
  completion_tokens: 80,
  prompt_tokens: 20,
  startTime: "2024-01-01T00:00:00.000Z",
  endTime: "2024-01-01T00:00:01.250Z",
  messages: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  response: "{}",
  metadata: { custom_llm_provider: "groq", user_api_key_user_id: "u1" },
};

describe("litellm spend log mapper", () => {
  test("maps tokens cost duration and bodies", () => {
    const [call] = mapLiteLlmSpendLogs("platform", [sample], true);
    expect(call?.id).toBe(sample.request_id);
    expect(call?.model).toBe("llama3");
    expect(call?.routedModel).toBe("llama3-70b");
    expect(call?.operation).toBe(LLM_OPERATION_CHAT);
    expect(call?.status).toBe(LLM_STATUS_OK);
    expect(call?.cost).toBe(0.000002);
    expect(call?.usage).toEqual({ promptTokens: 20, completionTokens: 80, totalTokens: 100 });
    expect(call?.durationMs).toBe(1250);
    expect(call?.caller).toBeUndefined();
    expect(call?.request).toEqual({ messages: [{ role: "user", content: "hi" }] });
    expect(call?.response).toBeUndefined();
  });

  test("maps errors and drops bodies when capture is off", () => {
    const [call] = mapLiteLlmSpendLogs("platform", [{ ...sample, error: "boom", status_code: 500 }], false);
    expect(call?.status).toBe(LLM_STATUS_ERROR);
    expect(call?.error).toBe("boom");
    expect(call?.request).toBeUndefined();
  });

  test("maps metadata.service as caller and ignores an email user", () => {
    const [tagged] = mapLiteLlmSpendLogs("platform", [{ ...sample, metadata: { ...sample.metadata, service: "worker" } }], false);
    expect(tagged?.caller).toBe("worker");
    const [emailed] = mapLiteLlmSpendLogs("platform", [{ ...sample, user: "dev@example.com" }], false);
    expect(emailed?.caller).toBeUndefined();
    const [named] = mapLiteLlmSpendLogs("platform", [{ ...sample, user: "api" }], false);
    expect(named?.caller).toBe("api");
  });
});

describe("litellm driver", () => {
  test("joins path prefixes onto spend logs", () => {
    expect(joinLlmUrl("http://127.0.0.1:4000", "/llm/", "spend/logs")).toBe("http://127.0.0.1:4000/llm/spend/logs");
    expect(spendLogsUrl("http://127.0.0.1:4000", "", undefined)).toContain("summarize=false");
  });

  test.each([401, 403, 404])("treats %i as a management-hop error not an empty list", async (status) => {
    const driver = litellmDriver(async () => ({ status, body: "missing" }));
    const cfg = emptyLlmSource();
    cfg.name = "platform";
    cfg.type = "litellm";
    cfg.capture.prompts = true;
    await expect(driver.fetch(cfg, { baseUrl: "http://gateway.local", pathPrefix: "", headers: {} })).rejects.toBeInstanceOf(LlmSourceHttpError);
  });
});
