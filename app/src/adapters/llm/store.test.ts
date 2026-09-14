import { describe, expect, test } from "bun:test";
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
      ingest("a", { timestamp: "2026-01-01T00:00:01.000Z", request: { token: "secret-a" } }),
      ingest("b", { timestamp: "2026-01-01T00:00:02.000Z" }),
    ]);
    store.upsert([ingest("a", { timestamp: "2026-01-01T00:00:03.000Z", model: "gpt-4o-mini" })]);
    const page = store.queryPage({});
    expect(page.calls.map((call) => call.id)).toEqual(["a", "b"]);
    expect(page.calls[0]?.model).toBe("gpt-4o-mini");
    expect(JSON.stringify(store.get("a"))).not.toContain("secret-a");
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
    store.upsert([ingest("ok"), ingest("err", { status: LLM_STATUS_ERROR, model: "gpt-4o-mini", request: { token: "still-secret" } })]);
    expect(store.facets({}).total).toBe(2);
    expect(store.facets({}).errors).toBe(1);
    expect(store.facets({}).byModel["gpt-4o"]).toBe(1);
    expect(JSON.stringify(store.get("err"))).not.toContain("still-secret");
  });
});
