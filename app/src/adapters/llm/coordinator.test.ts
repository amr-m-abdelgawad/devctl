import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyLlmSource, emptyRouteAuth, emptyService } from "../../domain/config/types.ts";
import { LLM_OPERATION_CHAT, LLM_STATUS_OK, type LlmCallIngest } from "../../domain/llm/llm.ts";
import type { LlmSourceDriver } from "../../ports/llm-source.ts";
import type { TokenManager } from "../google/token.ts";
import { LlmCoordinator } from "./coordinator.ts";
import { llmSourceFactory } from "./factory.ts";
import { LlmCallManager } from "./store.ts";

function ingest(id: string): LlmCallIngest {
  return {
    id,
    source: "platform",
    sourceType: "litellm",
    timestamp: "2026-01-01T00:00:00.000Z",
    status: LLM_STATUS_OK,
    model: "gpt-4o",
    operation: LLM_OPERATION_CHAT,
    attributes: {},
  };
}

function fakeDriver(onFetch: (ctx: { url: string; headers: Record<string, string>; pathPrefix: string }) => void): LlmSourceDriver {
  return {
    name: "litellm",
    capabilities: () => ({ hasBodies: true, hasCost: true, hasUsage: true, liveQuery: true }),
    fetch: async (_cfg, ctx) => {
      onFetch({ url: ctx.baseUrl, headers: ctx.headers, pathPrefix: ctx.pathPrefix });
      return [ingest("one")];
    },
  };
}

function iapTokens(): TokenManager {
  return {
    get: async () => ({ accessToken: "iap-token" }),
  } as unknown as TokenManager;
}

async function waitUntil(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  await new Promise((resolve) => setTimeout(resolve, 0));
  while (!pred() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("LlmCoordinator", () => {
  test("resolves a service port and dual-auth headers", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; pathPrefix: string }> = [];
    const cfg = defaultConfig();
    cfg.services.litellm = emptyService();
    cfg.services.litellm.command = { args: ["litellm"], shell: false };
    cfg.services.litellm.ports = [{ name: "http", value: 4000, auto: false }];
    const source = emptyLlmSource();
    source.name = "platform";
    source.type = "litellm";
    source.service = "litellm";
    source.auth = { type: "bearer", token_env: "LITELLM_MASTER_KEY", header: "x-litellm-api-key" };
    cfg.llm.enabled = true;
    cfg.llm.sources = [source];
    const store = new LlmCallManager();
    const coord = new LlmCoordinator({
      cfg: () => cfg,
      store,
      factory: () => ({ lookup: () => fakeDriver((ctx) => seen.push(ctx)) }),
      ports: () => new Map([["litellm", { http: 4000 }]]),
      log: () => undefined,
      env: { LITELLM_MASTER_KEY: "sk-test" },
    });
    await coord.start();
    await waitUntil(() => store.get("one")?.model === "gpt-4o");
    await coord.stop();
    expect(seen[0]?.url).toBe("http://127.0.0.1:4000");
    expect(seen[0]?.headers["x-litellm-api-key"]).toBe("sk-test");
    expect(store.get("one")?.model).toBe("gpt-4o");
  });

  test("passes endpoint and path_prefix through to the driver", async () => {
    const seen: Array<{ url: string; pathPrefix: string }> = [];
    const cfg = defaultConfig();
    const source = emptyLlmSource();
    source.name = "via-gateway";
    source.type = "litellm";
    source.endpoint = "https://gateway.internal.example";
    source.path_prefix = "/llm";
    source.auth = { type: "bearer", token_env: "LITELLM_MASTER_KEY", header: "Authorization" };
    cfg.llm.enabled = true;
    cfg.llm.sources = [source];
    const coord = new LlmCoordinator({
      cfg: () => cfg,
      store: new LlmCallManager(),
      factory: () => ({ lookup: () => fakeDriver((ctx) => seen.push({ url: ctx.url, pathPrefix: ctx.pathPrefix })) }),
      ports: () => new Map(),
      log: () => undefined,
      env: { LITELLM_MASTER_KEY: "sk-test" },
    });
    await coord.start();
    await waitUntil(() => seen.length > 0);
    await coord.stop();
    expect(seen[0]?.url).toBe("https://gateway.internal.example");
    expect(seen[0]?.pathPrefix).toBe("/llm");
  });

  test("uses management_endpoint when via.route only forwards chat traffic", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const cfg = defaultConfig();
    cfg.proxy.routes = [{
      name: "llm-apps",
      match: { host: "llm.local", path: "" },
      upstream: { url: "http://127.0.0.1:8080" },
      auth: { ...emptyRouteAuth(), type: "iap", audience: "/projects/1/iap", identity: { type: "user", service_account: "" } },
    }];
    const source = emptyLlmSource();
    source.name = "via";
    source.type = "litellm";
    source.via.route = "llm-apps";
    source.management_endpoint = "http://127.0.0.1:4000";
    source.auth = { type: "bearer", token_env: "LITELLM_MASTER_KEY", header: "x-litellm-api-key" };
    cfg.llm.enabled = true;
    cfg.llm.sources = [source];
    const store = new LlmCallManager();
    const coord = new LlmCoordinator({
      cfg: () => cfg,
      store,
      factory: () => ({ lookup: () => fakeDriver((ctx) => seen.push({ url: ctx.url, headers: ctx.headers })) }),
      ports: () => new Map(),
      log: () => undefined,
      env: { LITELLM_MASTER_KEY: "sk-test" },
      tokens: iapTokens(),
    });
    await coord.start();
    await waitUntil(() => seen.length > 0);
    await coord.stop();
    expect(seen[0]?.url).toBe("http://127.0.0.1:4000");
    expect(seen[0]?.headers.authorization).toBe("Bearer iap-token");
    expect(seen[0]?.headers["x-litellm-api-key"]).toBe("sk-test");
  });

  test("resolves via.route to the proxy upstream when it is the management hop", async () => {
    const seen: string[] = [];
    const cfg = defaultConfig();
    cfg.proxy.routes = [{
      name: "litellm",
      match: { host: "llm.local", path: "/llm" },
      upstream: { url: "https://gateway.internal.example" },
      auth: emptyRouteAuth(),
    }];
    const source = emptyLlmSource();
    source.name = "via-devctl-proxy";
    source.type = "litellm";
    source.via.route = "litellm";
    source.path_prefix = "/llm";
    cfg.llm.enabled = true;
    cfg.llm.sources = [source];
    const coord = new LlmCoordinator({
      cfg: () => cfg,
      store: new LlmCallManager(),
      factory: () => ({ lookup: () => fakeDriver((ctx) => seen.push(ctx.url)) }),
      ports: () => new Map(),
      log: () => undefined,
    });
    await coord.start();
    await waitUntil(() => seen.length > 0);
    await coord.stop();
    expect(seen[0]).toBe("https://gateway.internal.example");
  });

  test("looks up the builtin litellm driver", () => {
    expect(llmSourceFactory().lookup("litellm")?.name).toBe("litellm");
    expect(llmSourceFactory().lookup("missing")).toBeUndefined();
  });

  test("registers the builtin proxy push driver", () => {
    const driver = llmSourceFactory().lookup("proxy");
    expect(driver?.name).toBe("proxy");
    expect(driver?.mode).toBe("push");
  });

  test("never polls a push-mode source (no fetch, no source error)", async () => {
    let fetchCalled = false;
    const cfg = defaultConfig();
    const source = emptyLlmSource();
    source.name = "apigee-llm";
    source.type = "proxy";
    source.via.route = "apigee-llm";
    cfg.llm.enabled = true;
    cfg.llm.sources = [source];
    const store = new LlmCallManager();
    const pushDriver: LlmSourceDriver = {
      name: "proxy",
      mode: "push",
      capabilities: () => ({ hasBodies: true, hasCost: false, hasUsage: false, liveQuery: true }),
      fetch: async () => {
        fetchCalled = true;
        return [];
      },
    };
    const coord = new LlmCoordinator({
      cfg: () => cfg,
      store,
      factory: () => ({ lookup: () => pushDriver }),
      ports: () => new Map(),
      log: () => undefined,
    });
    await coord.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await coord.stop();
    expect(fetchCalled).toBe(false);
    expect(store.sourceErrors()).toEqual([]);
  });

  test("clears a stale source error when a name becomes a push source", async () => {
    const cfg = defaultConfig();
    const source = emptyLlmSource();
    source.name = "apigee-llm";
    source.type = "proxy";
    source.via.route = "apigee-llm";
    cfg.llm.enabled = true;
    cfg.llm.sources = [source];
    const store = new LlmCallManager();
    store.setSourceError("apigee-llm", "old litellm error", 401); // left over from a pull config
    const pushDriver: LlmSourceDriver = {
      name: "proxy",
      mode: "push",
      capabilities: () => ({ hasBodies: true, hasCost: false, hasUsage: false, liveQuery: true }),
      fetch: async () => [],
    };
    const coord = new LlmCoordinator({
      cfg: () => cfg,
      store,
      factory: () => ({ lookup: () => pushDriver }),
      ports: () => new Map(),
      log: () => undefined,
    });
    await coord.start();
    await coord.stop();
    expect(store.sourceErrors()).toEqual([]);
  });
});
