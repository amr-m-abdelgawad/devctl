import { describe, expect, spyOn, test } from "bun:test";
import { Detector } from "../secrets/detector.ts";
import { LlmCallManager } from "./store.ts";
import { LLM_OPERATION_CHAT, LLM_STATUS_ERROR, LLM_STATUS_OK, type LlmCallIngest } from "../../domain/llm/llm.ts";

function ingest(id: string, overrides: Partial<LlmCallIngest> = {}): LlmCallIngest {
  return {
    id,
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

describe("LlmCallManager", () => {
  test("upserts by id, redacts, and pages newest first", () => {
    const store = new LlmCallManager(new Detector(["token"], []));
    store.upsert([
      ingest("a", { timestamp: "2026-01-01T00:00:01.000Z", request: { token: "secret-a-0123456789abcd" } }),
      ingest("b", { timestamp: "2026-01-01T00:00:02.000Z" }),
    ]);
    store.upsert([ingest("a", { timestamp: "2026-01-01T00:00:03.000Z", model: "gpt-4o-mini" })]);
    const page = store.queryPage({});
    expect(page.calls.map((call) => call.id)).toEqual(["a", "b"]);
    expect(page.calls[0]?.model).toBe("gpt-4o-mini");
    expect(JSON.stringify(store.get("a"))).not.toContain("secret-a-0123456789abcd");
    const next = store.queryPage({}, { cursor: page.nextCursor, limit: 1 });
    expect(next.calls).toHaveLength(0);
    expect(next.hasNext).toBe(false);
  });

  test("records source errors separately from calls", () => {
    const store = new LlmCallManager();
    store.setSourceError("platform", "not LiteLLM management", 404);
    expect(store.queryPage({}).errors[0]?.status).toBe(404);
    store.clearSourceError("platform");
    expect(store.sourceErrors()).toEqual([]);
    store.setSecrets(["token"], []);
    store.upsert([ingest("ok"), ingest("err", { status: LLM_STATUS_ERROR, model: "gpt-4o-mini", request: { token: "still-secret-0123456789" } })]);
    expect(store.facets({}).total).toBe(2);
    expect(store.facets({}).errors).toBe(1);
    expect(store.facets({}).byModel["gpt-4o"]).toBe(1);
    expect(JSON.stringify(store.get("err"))).not.toContain("still-secret-0123456789");
  });

  test("evicting bodies over the budget keeps every call listed and does not throw", () => {
    const prompt = "x".repeat(400);
    const store = new LlmCallManager(new Detector([], []), 100, 1_000);
    expect(() => store.upsert([ingest("a", { request: { prompt } }), ingest("b", { request: { prompt } }), ingest("c", { request: { prompt } })])).not.toThrow();
    expect(store.queryPage({}).calls.map((call) => call.id)).toEqual(["c", "b", "a"]);
    expect(store.get("a")?.request).toBeUndefined();
    expect(store.get("a")?.attributes.body).toBe("evicted");
    expect(store.get("c")?.request).toEqual({ prompt });
    expect(store.queryPage({ search: "xxxx" }).calls.map((call) => call.id)).toEqual(["c", "b"]);
  });

  test("shedding bodies keeps the metadata, stops body search, and does not throw", () => {
    const store = new LlmCallManager(new Detector([], []));
    store.upsert([ingest("a", { request: { prompt: "hi" }, response: { text: "a reply" } })]);
    expect(() => store.shedBodies()).not.toThrow();
    expect(() => store.shedBodies()).not.toThrow();
    const call = store.get("a");
    expect(call?.request).toBeUndefined();
    expect(call?.response).toBeUndefined();
    expect(call?.attributes.body).toBe("evicted");
    expect(store.queryPage({ search: "a reply" }).calls).toHaveLength(0);
    expect(store.queryPage({ search: "gpt-4o" }).calls).toHaveLength(1);
    store.upsert([ingest("b", { request: { prompt: "again" } })]);
    expect(store.get("b")?.request).toEqual({ prompt: "again" });
  });

  test("holds each body as text and parses it only when one call is read", () => {
    const store = new LlmCallManager(new Detector([], []));
    const request = { messages: [{ role: "user", content: "hello there" }] };
    store.upsert([ingest("a", { request, response: "plain text reply" })]);
    const parse = spyOn(JSON, "parse");
    try {
      const summary = store.queryPage({ search: "hello there" }, { summary: true });
      expect(summary.calls.map((call) => call.id)).toEqual(["a"]);
      expect(summary.calls[0]?.request).toBeUndefined();
      expect(summary.calls[0]?.attributes.body).toBe("omitted");
      expect(parse).not.toHaveBeenCalled();
      const read = store.get("a");
      expect(parse).toHaveBeenCalledTimes(1);
      expect(read?.request).toEqual(request);
      expect(read?.response).toBe("plain text reply");
      // Every read is a fresh copy, so a caller cannot change what is held.
      (read?.request as { messages: unknown[] }).messages.length = 0;
      expect(store.get("a")?.request).toEqual(request);
    } finally {
      parse.mockRestore();
    }
  });
});
