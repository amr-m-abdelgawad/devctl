import { describe, expect, test } from "bun:test";
import { emptyLlm, emptyLlmVia, llmViaRoutes } from "../../domain/config/types.ts";
import { applyLlm } from "./merge.ts";

describe("llm via.route / via.routes", () => {
  test("decodes via.route sugar with an empty routes list", () => {
    const llm = emptyLlm();
    applyLlm(llm, {
      enabled: true,
      sources: [{ name: "one", type: "proxy", via: { route: "foo" } }],
    });
    expect(llm.sources[0]?.via).toEqual({ route: "foo", routes: [] });
    expect(llmViaRoutes(llm.sources[0]!.via)).toEqual(["foo"]);
  });

  test("decodes via.routes and unions them with via.route", () => {
    const llm = emptyLlm();
    applyLlm(llm, {
      sources: [{
        name: "multi",
        type: "proxy",
        via: { route: "foo", routes: ["bar", "foo", " baz ", ""] },
      }],
    });
    expect(llm.sources[0]?.via.route).toBe("foo");
    expect(llm.sources[0]?.via.routes).toEqual(["bar", "foo", " baz ", ""]);
    expect(llmViaRoutes(llm.sources[0]!.via)).toEqual(["foo", "bar", "baz"]);
  });

  test("replaces via.routes when an overlay sets the list", () => {
    const llm = emptyLlm();
    applyLlm(llm, {
      sources: [{ name: "multi", type: "proxy", via: { route: "foo", routes: ["old"] } }],
    });
    applyLlm(llm, {
      sources: [{ name: "multi", type: "proxy", via: { routes: ["alpha", "beta"] } }],
    });
    expect(llm.sources[0]?.via).toEqual({ route: "", routes: ["alpha", "beta"] });
    expect(llmViaRoutes(llm.sources[0]!.via)).toEqual(["alpha", "beta"]);
  });

  test("decodes cost_per_token when present and leaves it undefined otherwise", () => {
    const llm = emptyLlm();
    applyLlm(llm, {
      sources: [{ name: "one", type: "proxy", via: { route: "foo" }, cost_per_token: { input: 0.001, output: 0.002 } }],
    });
    expect(llm.sources[0]?.cost_per_token).toEqual({ input: 0.001, output: 0.002 });
    applyLlm(llm, {
      sources: [{ name: "one", type: "proxy", via: { route: "foo" } }],
    });
    expect(llm.sources[0]?.cost_per_token).toBeUndefined();
  });

  test("unusable cost_per_token rates stay NaN instead of coercing to zero", () => {
    const llm = emptyLlm();
    applyLlm(llm, {
      sources: [{ name: "one", type: "proxy", via: { route: "foo" }, cost_per_token: { input: "invalid", output: null } }],
    });
    expect(Number.isNaN(llm.sources[0]?.cost_per_token?.input)).toBe(true);
    expect(Number.isNaN(llm.sources[0]?.cost_per_token?.output)).toBe(true);
    applyLlm(llm, {
      sources: [{ name: "one", type: "proxy", via: { route: "foo" }, cost_per_token: { input: "0.001", output: "0.002" } }],
    });
    expect(llm.sources[0]?.cost_per_token).toEqual({ input: 0.001, output: 0.002 });
  });

  test("decodes capture.field_map when present and leaves it undefined otherwise", () => {
    const llm = emptyLlm();
    applyLlm(llm, {
      sources: [{
        name: "one",
        type: "proxy",
        via: { route: "foo" },
        capture: { field_map: { model: "$.request.model_name", cost: "$.response.metadata.price" } },
      }],
    });
    expect(llm.sources[0]?.capture.field_map).toEqual({
      model: "$.request.model_name",
      cost: "$.response.metadata.price",
    });
    applyLlm(llm, {
      sources: [{ name: "one", type: "proxy", via: { route: "foo" } }],
    });
    expect(llm.sources[0]?.capture.field_map).toBeUndefined();
  });

  test("llmViaRoutes keeps route first and skips empties", () => {
    expect(llmViaRoutes(emptyLlmVia())).toEqual([]);
    expect(llmViaRoutes({ route: "  ", routes: ["", " a ", "a"] })).toEqual(["a"]);
  });
});
