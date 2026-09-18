import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyLlmSource, type DevctlConfig, type LlmSourceConfig } from "../../domain/config/types.ts";
import { LLM_OPERATION_OTHER } from "../../domain/llm/llm.ts";
import { LlmCallManager } from "./store.ts";
import { ProxyCaptureSink, type ProxyCaptureSinkDeps } from "./proxy-capture.ts";

const jsonHeaders = { "content-type": "application/json" };

function cfgWithProxySource(mutate: (source: LlmSourceConfig) => void = () => undefined): DevctlConfig {
  const cfg = defaultConfig();
  const source = emptyLlmSource();
  source.name = "apigee-llm";
  source.type = "proxy";
  source.via.route = "apigee-llm";
  mutate(source);
  cfg.llm.enabled = true;
  cfg.llm.sources = [source];
  return cfg;
}

describe("ProxyCaptureSink.begin", () => {
  test("captures a POST JSON completion on a tagged route", () => {
    const sink = new ProxyCaptureSink({ cfg: () => cfgWithProxySource(), store: new LlmCallManager() });
    const rec = sink.begin({ routeName: "apigee-llm", method: "POST", path: "/llm/v1/chat/completions", requestHeaders: jsonHeaders });
    expect(rec).toBeDefined();
    expect(rec?.maxBytes).toBeGreaterThan(0);
  });

  test("ignores non-POST, non-JSON, non-completion paths and unmatched routes", () => {
    const sink = new ProxyCaptureSink({ cfg: () => cfgWithProxySource(), store: new LlmCallManager() });
    const chat = "/llm/v1/chat/completions";
    expect(sink.begin({ routeName: "apigee-llm", method: "GET", path: chat, requestHeaders: jsonHeaders })).toBeUndefined();
    expect(sink.begin({ routeName: "apigee-llm", method: "POST", path: "/llm/v1/models", requestHeaders: jsonHeaders })).toBeUndefined();
    expect(sink.begin({ routeName: "apigee-llm", method: "POST", path: "/generations/v1alpha2", requestHeaders: jsonHeaders })).toBeUndefined();
    expect(sink.begin({ routeName: "apigee-llm", method: "POST", path: chat, requestHeaders: { "content-type": "text/plain" } })).toBeUndefined();
    expect(sink.begin({ routeName: "other", method: "POST", path: chat, requestHeaders: jsonHeaders })).toBeUndefined();
    // Formats the reassembler does not understand are not captured.
    expect(sink.begin({ routeName: "apigee-llm", method: "POST", path: "/llm/v1/messages", requestHeaders: jsonHeaders })).toBeUndefined();
    expect(sink.begin({ routeName: "apigee-llm", method: "POST", path: "/llm/v1/responses", requestHeaders: jsonHeaders })).toBeUndefined();
  });

  test("returns undefined when the inspector is disabled", () => {
    const cfg = cfgWithProxySource();
    cfg.llm.enabled = false;
    const sink = new ProxyCaptureSink({ cfg: () => cfg, store: new LlmCallManager() });
    expect(sink.begin({ routeName: "apigee-llm", method: "POST", path: "/llm/v1/chat/completions", requestHeaders: jsonHeaders })).toBeUndefined();
  });

  test("captures a configured proprietary path in addition to OpenAI completions", () => {
    const sink = new ProxyCaptureSink({
      cfg: () => cfgWithProxySource((source) => { source.capture.paths = ["/generations/v1alpha2"]; }),
      store: new LlmCallManager(),
    });
    expect(sink.begin({
      routeName: "apigee-llm",
      method: "POST",
      path: "/generations/v1alpha2",
      requestHeaders: jsonHeaders,
    })).toBeDefined();
    expect(sink.begin({
      routeName: "apigee-llm",
      method: "POST",
      path: "/llm/generations/v1alpha2?alt=json",
      requestHeaders: jsonHeaders,
    })).toBeDefined();
    expect(sink.begin({
      routeName: "apigee-llm",
      method: "POST",
      path: "/llm/v1/chat/completions",
      requestHeaders: jsonHeaders,
    })).toBeDefined();
    expect(sink.begin({
      routeName: "apigee-llm",
      method: "POST",
      path: "/llm/v1/messages",
      requestHeaders: jsonHeaders,
    })).toBeUndefined();
    expect(sink.begin({
      routeName: "apigee-llm",
      method: "GET",
      path: "/generations/v1alpha2",
      requestHeaders: jsonHeaders,
    })).toBeUndefined();
    expect(sink.begin({
      routeName: "apigee-llm",
      method: "POST",
      path: "/llm/v1/models",
      requestHeaders: jsonHeaders,
    })).toBeUndefined();
  });

  test("captures /messages only when it is listed in capture.paths", () => {
    const sink = new ProxyCaptureSink({
      cfg: () => cfgWithProxySource((source) => { source.capture.paths = ["/messages"]; }),
      store: new LlmCallManager(),
    });
    expect(sink.begin({
      routeName: "apigee-llm",
      method: "POST",
      path: "/llm/v1/messages",
      requestHeaders: jsonHeaders,
    })).toBeDefined();
  });

  test("does not treat /completions in the query string as a completion path", () => {
    const sink = new ProxyCaptureSink({ cfg: () => cfgWithProxySource(), store: new LlmCallManager() });
    expect(sink.begin({
      routeName: "apigee-llm",
      method: "POST",
      path: "/llm/v1/models?q=/completions",
      requestHeaders: jsonHeaders,
    })).toBeUndefined();
  });
});

describe("ProxyCaptureSink recorder", () => {
  async function drive(cfg: DevctlConfig, store: LlmCallManager, begin: Parameters<ProxyCaptureSink["begin"]>[0] = {
    routeName: "apigee-llm",
    method: "POST",
    path: "/llm/v1/chat/completions",
    requestHeaders: jsonHeaders,
  }, lookupCaller?: ProxyCaptureSinkDeps["lookupCaller"]): Promise<void> {
    const sink = new ProxyCaptureSink({ cfg: () => cfg, store, lookupCaller });
    const rec = sink.begin(begin);
    if (!rec) throw new Error("expected a recorder");
    rec.setRequestBody(Buffer.from(JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] })));
    rec.setResponseContentType("application/json");
    rec.appendResponse(Buffer.from(JSON.stringify({
      id: "chatcmpl-9",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "yo" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })));
    await rec.finish({ status: 200, durationMs: 10, requestId: "req-9", traceId: "t-9", timestamp: "2026-01-01T00:00:00.000Z" });
  }

  test("upserts a mapped call on finish", async () => {
    const store = new LlmCallManager();
    await drive(cfgWithProxySource(), store);
    const call = store.get("req-9");
    expect(call?.model).toBe("gpt-4o");
    expect(call?.source).toBe("apigee-llm");
    expect(call?.usage?.totalTokens).toBe(2);
    expect((call?.response as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("yo");
  });

  test("strips bodies when capture.prompts is false", async () => {
    const store = new LlmCallManager();
    await drive(cfgWithProxySource((source) => { source.capture.prompts = false; }), store);
    const call = store.get("req-9");
    expect(call).toBeDefined();
    expect(call?.request).toBeUndefined();
    expect(call?.response).toBeUndefined();
    expect(call?.model).toBe("gpt-4o");
  });

  test("records the caller from X-Devctl-Service and skips peer lookup", async () => {
    const store = new LlmCallManager();
    let lookedUp = 0;
    await drive(
      cfgWithProxySource(),
      store,
      {
        routeName: "apigee-llm",
        method: "POST",
        path: "/llm/v1/chat/completions",
        requestHeaders: { ...jsonHeaders, "x-devctl-service": "worker" },
        peer: { address: "127.0.0.1", port: 54321 },
      },
      async () => {
        lookedUp += 1;
        return "api";
      },
    );
    expect(store.get("req-9")?.caller).toBe("worker");
    expect(lookedUp).toBe(0);
  });

  test("falls back to an injected loopback peer lookup started at begin", async () => {
    const store = new LlmCallManager();
    let lookedUp = 0;
    const held = Promise.withResolvers<string>();
    const sink = new ProxyCaptureSink({
      cfg: () => cfgWithProxySource(),
      store,
      lookupCaller: async () => {
        lookedUp += 1;
        return held.promise;
      },
    });
    const rec = sink.begin({
      routeName: "apigee-llm",
      method: "POST",
      path: "/llm/v1/chat/completions",
      requestHeaders: jsonHeaders,
      peer: { address: "127.0.0.1", port: 54321 },
    });
    if (!rec) throw new Error("expected a recorder");
    expect(lookedUp).toBe(1);
    rec.setRequestBody(Buffer.from(JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] })));
    rec.setResponseContentType("application/json");
    rec.appendResponse(Buffer.from("{}"));
    held.resolve("api");
    await rec.finish({ status: 200, durationMs: 1, requestId: "req-9", timestamp: "2026-01-01T00:00:00.000Z" });
    expect(store.get("req-9")?.caller).toBe("api");
  });

  test("records caller from completion metadata.service when the peer is unknown", async () => {
    const store = new LlmCallManager();
    const sink = new ProxyCaptureSink({ cfg: () => cfgWithProxySource(), store });
    const rec = sink.begin({ routeName: "apigee-llm", method: "POST", path: "/llm/v1/chat/completions", requestHeaders: jsonHeaders });
    if (!rec) throw new Error("expected a recorder");
    rec.setRequestBody(Buffer.from(JSON.stringify({
      model: "gpt-4o",
      metadata: { service: "invoices-api" },
      messages: [{ role: "user", content: "hi" }],
    })));
    rec.setResponseContentType("application/json");
    rec.appendResponse(Buffer.from("{}"));
    await rec.finish({ status: 200, durationMs: 1, requestId: "req-meta", timestamp: "2026-01-01T00:00:00.000Z" });
    expect(store.get("req-meta")?.caller).toBe("invoices-api");
  });

  test("does not look up a non-loopback peer", async () => {
    const store = new LlmCallManager();
    let lookedUp = 0;
    await drive(
      cfgWithProxySource(),
      store,
      {
        routeName: "apigee-llm",
        method: "POST",
        path: "/llm/v1/chat/completions",
        requestHeaders: jsonHeaders,
        peer: { address: "8.8.8.8", port: 54321 },
      },
      async () => {
        lookedUp += 1;
        return "api";
      },
    );
    expect(store.get("req-9")?.caller).toBeUndefined();
    expect(lookedUp).toBe(0);
  });

  test("uses the OpenAI user field when no header or peer matches", async () => {
    const store = new LlmCallManager();
    const sink = new ProxyCaptureSink({ cfg: () => cfgWithProxySource(), store });
    const rec = sink.begin({ routeName: "apigee-llm", method: "POST", path: "/llm/v1/chat/completions", requestHeaders: jsonHeaders });
    if (!rec) throw new Error("expected a recorder");
    rec.setRequestBody(Buffer.from(JSON.stringify({ model: "gpt-4o", user: "worker", messages: [{ role: "user", content: "hi" }] })));
    rec.setResponseContentType("application/json");
    rec.appendResponse(Buffer.from("{}"));
    await rec.finish({ status: 200, durationMs: 1, requestId: "req-user", timestamp: "2026-01-01T00:00:00.000Z" });
    expect(store.get("req-user")?.caller).toBe("worker");
  });

  test("truncates the response body at max_bytes", async () => {
    const store = new LlmCallManager();
    const sink = new ProxyCaptureSink({ cfg: () => cfgWithProxySource((source) => { source.capture.max_bytes = 8; }), store });
    const rec = sink.begin({ routeName: "apigee-llm", method: "POST", path: "/llm/v1/chat/completions", requestHeaders: jsonHeaders });
    if (!rec) throw new Error("expected a recorder");
    expect(rec.maxBytes).toBe(8);
    rec.setResponseContentType("application/json");
    expect(rec.appendResponse(Buffer.from("12345678"))).toBe(true);
    expect(rec.appendResponse(Buffer.from("more"))).toBe(false);
    await rec.finish({ status: 200, durationMs: 1, requestId: "req-cap", timestamp: "2026-01-01T00:00:00.000Z" });
    expect(store.get("req-cap")?.attributes.response_truncated).toBe(true);
  });

  test("stores proprietary JSON on a configured path without inventing usage", async () => {
    const store = new LlmCallManager();
    const sink = new ProxyCaptureSink({
      cfg: () => cfgWithProxySource((source) => { source.capture.paths = ["/generations/v1alpha2"]; }),
      store,
    });
    const rec = sink.begin({
      routeName: "apigee-llm",
      method: "POST",
      path: "/llm/generations/v1alpha2",
      requestHeaders: jsonHeaders,
    });
    if (!rec) throw new Error("expected a recorder");
    rec.setRequestBody(Buffer.from(JSON.stringify({ contents: [{ text: "hi" }] })));
    rec.setResponseContentType("application/json");
    rec.appendResponse(Buffer.from(JSON.stringify({ candidates: [{ text: "yo" }] })));
    await rec.finish({ status: 200, durationMs: 12, requestId: "req-raw", timestamp: "2026-01-01T00:00:00.000Z" });
    const call = store.get("req-raw");
    expect(call?.operation).toBe(LLM_OPERATION_OTHER);
    expect(call?.model).toBe("unknown");
    expect(call?.usage).toBeUndefined();
    expect(call?.durationMs).toBe(12);
    expect(call?.attributes.schema).toBe("raw");
    expect(call?.request).toEqual({ contents: [{ text: "hi" }] });
    expect(call?.response).toEqual({ candidates: [{ text: "yo" }] });
  });

  test("still maps OpenAI completions when capture.paths is set", async () => {
    const store = new LlmCallManager();
    await drive(cfgWithProxySource((source) => { source.capture.paths = ["/generations/v1alpha2"]; }), store);
    const call = store.get("req-9");
    expect(call?.model).toBe("gpt-4o");
    expect(call?.usage?.totalTokens).toBe(2);
    expect(call?.attributes.schema).toBeUndefined();
  });
});
