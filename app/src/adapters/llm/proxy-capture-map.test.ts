import { describe, expect, test } from "bun:test";
import { LLM_OPERATION_CHAT, LLM_OPERATION_EMBEDDING, LLM_OPERATION_OTHER, LLM_STATUS_ERROR, LLM_STATUS_OK } from "../../domain/llm/llm.ts";
import { assembleSseCompletion, mapProxyCapture, type ProxyCaptureInput } from "./proxy-capture-map.ts";

function base(overrides: Partial<ProxyCaptureInput> = {}): ProxyCaptureInput {
  return {
    source: "apigee-llm",
    route: "apigee-llm",
    method: "POST",
    path: "/llm/v1/chat/completions",
    status: 200,
    durationMs: 42,
    requestId: "req-1",
    traceId: "trace-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    responseContentType: "application/json",
    ...overrides,
  };
}

describe("mapProxyCapture", () => {
  test("maps a non-streamed JSON chat completion", () => {
    const call = mapProxyCapture(base({
      requestBody: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      responseBody: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-4o-2024",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    }));
    expect(call.id).toBe("req-1");
    expect(call.requestId).toBe("req-1");
    expect(call.traceId).toBe("trace-1");
    expect(call.sourceType).toBe("proxy");
    expect(call.status).toBe(LLM_STATUS_OK);
    expect(call.model).toBe("gpt-4o");
    expect(call.routedModel).toBe("gpt-4o-2024");
    expect(call.operation).toBe(LLM_OPERATION_CHAT);
    expect(call.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    expect(call.cost).toBeUndefined();
    expect(call.attributes.response_id).toBe("chatcmpl-1");
    expect(call.attributes.stream).toBe(false);
    expect(call.caller).toBeUndefined();
    expect((call.response as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("hello");
  });

  test("copies an attributed caller onto the ingest", () => {
    expect(mapProxyCapture(base({ caller: "worker" })).caller).toBe("worker");
  });

  test("does not use the upstream response id as the store id (retry collision)", () => {
    const first = mapProxyCapture(base({ requestId: "req-a", responseBody: JSON.stringify({ id: "chatcmpl-dup", model: "m" }) }));
    const second = mapProxyCapture(base({ requestId: "req-b", responseBody: JSON.stringify({ id: "chatcmpl-dup", model: "m" }) }));
    expect(first.id).toBe("req-a");
    expect(second.id).toBe("req-b");
    expect(first.id).not.toBe(second.id);
  });

  test("reassembles a streamed chat completion with usage", () => {
    const raw = [
      'data: {"id":"chatcmpl-2","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
      'data: {"id":"chatcmpl-2","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-2","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"chatcmpl-2","model":"gpt-4o","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const call = mapProxyCapture(base({ responseContentType: "text/event-stream", responseBody: raw }));
    const response = call.response as { id: string; choices: Array<{ message: { content: string }; finish_reason: string }> };
    expect(response.id).toBe("chatcmpl-2");
    expect(response.choices[0]?.message.content).toBe("Hello");
    expect(response.choices[0]?.finish_reason).toBe("stop");
    expect(call.usage).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
    expect(call.attributes.stream).toBe(true);
    expect(call.attributes.finish_reason).toBe("stop");
  });

  test("assembles streamed tool-call arguments", () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"SF\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const assembled = assembleSseCompletion(raw) as { choices: Array<{ message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
    const tool = assembled.choices[0]?.message.tool_calls[0];
    expect(tool?.id).toBe("call_1");
    expect(tool?.function.name).toBe("get_weather");
    expect(tool?.function.arguments).toBe('{"city":"SF"}');
  });

  test("tolerates a partial stream (client disconnect, no [DONE], truncated frame)", () => {
    const raw = [
      'data: {"id":"chatcmpl-3","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"par"}}]}',
      'data: {"id":"chatcmpl-3","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ti',
    ].join("\n\n");
    const call = mapProxyCapture(base({ status: 200, responseContentType: "text/event-stream", responseBody: raw, responseTruncated: true }));
    const response = call.response as { choices: Array<{ message: { content: string } }> };
    expect(response.choices[0]?.message.content).toBe("par");
    expect(call.attributes.response_truncated).toBe(true);
  });

  test("falls back to raw text when the JSON response does not parse", () => {
    const call = mapProxyCapture(base({ responseBody: "upstream exploded", responseContentType: "application/json" }));
    expect(call.response).toBe("upstream exploded");
  });

  test("marks an error status and extracts the error message", () => {
    const call = mapProxyCapture(base({ status: 429, responseBody: JSON.stringify({ error: { message: "rate limited" } }) }));
    expect(call.status).toBe(LLM_STATUS_ERROR);
    expect(call.error).toBe("rate limited");
  });

  test("emits a usable row when the upstream errored with no bodies", () => {
    const call = mapProxyCapture(base({ status: 502, responseBody: undefined, requestOmitted: true }));
    expect(call.id).toBe("req-1");
    expect(call.status).toBe(LLM_STATUS_ERROR);
    expect(call.error).toContain("502");
    expect(call.request).toBeUndefined();
    expect(call.response).toBeUndefined();
    expect(call.attributes.request_omitted).toBe(true);
  });

  test("classifies embeddings by path", () => {
    const call = mapProxyCapture(base({
      path: "/llm/v1/embeddings",
      requestBody: JSON.stringify({ model: "text-embedding-3-small", input: "hi" }),
      responseBody: JSON.stringify({ model: "text-embedding-3-small", data: [], usage: { prompt_tokens: 2, total_tokens: 2 } }),
    }));
    expect(call.operation).toBe(LLM_OPERATION_EMBEDDING);
    expect(call.usage).toEqual({ promptTokens: 2, completionTokens: undefined, totalTokens: 2 });
  });

  test("stores proprietary JSON as-is on a raw capture", () => {
    const request = { contents: [{ text: "hi" }], model: "internal-llm" };
    const response = { candidates: [{ text: "yo" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }, finish_reason: "stop" };
    const call = mapProxyCapture(base({
      path: "/generations/v1alpha2",
      raw: true,
      requestBody: JSON.stringify(request),
      responseBody: JSON.stringify(response),
    }));
    expect(call.request).toEqual(request);
    expect(call.response).toEqual(response);
    expect(call.operation).toBe(LLM_OPERATION_OTHER);
    expect(call.model).toBe("internal-llm");
    expect(call.usage).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
    expect(call.attributes.schema).toBe("raw");
    expect(call.attributes.finish_reason).toBe("stop");
  });

  test("keeps raw SSE text instead of fabricating a chat.completion", () => {
    const sse = [
      "data: {\"delta\":\"Hel\"}",
      "data: {\"delta\":\"lo\"}",
      "data: [DONE]",
      "",
    ].join("\n");
    const call = mapProxyCapture(base({
      path: "/generations/v1alpha2",
      raw: true,
      responseContentType: "text/event-stream",
      responseBody: sse,
    }));
    expect(call.response).toBe(sse);
    expect(call.attributes.schema).toBe("raw");
    expect(call.attributes.stream).toBe(true);
    expect(call.usage).toBeUndefined();
    expect((call.response as string).includes("chat.completion")).toBe(false);
  });

  test("does not mark an OpenAI capture as raw", () => {
    const call = mapProxyCapture(base({
      requestBody: JSON.stringify({ model: "gpt-4o", messages: [] }),
      responseBody: JSON.stringify({ model: "gpt-4o", choices: [] }),
    }));
    expect(call.attributes.schema).toBeUndefined();
  });
});

describe("assembleSseCompletion", () => {
  test("returns undefined when there are no data frames", () => {
    expect(assembleSseCompletion(": keep-alive\n\n")).toBeUndefined();
    expect(assembleSseCompletion("")).toBeUndefined();
  });
});
