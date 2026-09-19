import { describe, expect, test } from "bun:test";
import { getJsonPath, jsonValueToString } from "./json-path.ts";

describe("json path", () => {
  test("reads leaves, nested objects, and serializes non-leaves", () => {
    const body = { access_token: "abc", nested: { n: 2 }, list: [1] };
    expect(getJsonPath(body, "access_token")).toBe("abc");
    expect(getJsonPath(body, "nested.n")).toBe(2);
    expect(getJsonPath(body, "missing")).toBeUndefined();
    expect(jsonValueToString("abc")).toBe("abc");
    expect(jsonValueToString(2)).toBe("2");
    expect(jsonValueToString({ a: 1 })).toBe("{\"a\":1}");
    expect(jsonValueToString([1, 2])).toBe("[1,2]");
  });

  test("walks a $ root, dotted keys, and [n] indexes", () => {
    const root = {
      request: { model_name: "claude-sonnet-5" },
      response: {
        metadata: { input_tokens: 1514, price: 0.048 },
        choices: [{ finish_reason: "stop" }],
      },
    };
    expect(getJsonPath(root, "$")).toBe(root);
    expect(getJsonPath(root, "$.request.model_name")).toBe("claude-sonnet-5");
    expect(getJsonPath(root, "$.response.metadata.input_tokens")).toBe(1514);
    expect(getJsonPath(root, "$.response.choices[0].finish_reason")).toBe("stop");
    expect(getJsonPath(root, "$.response.choices[1].finish_reason")).toBeUndefined();
    expect(getJsonPath(root, "$.missing.leaf")).toBeUndefined();
    expect(getJsonPath(root, "$.response.choices.finish_reason")).toBeUndefined();
  });

  test("rejects malformed paths", () => {
    const body = { a: [{ b: 1 }] };
    expect(getJsonPath(body, "$.")).toBeUndefined();
    expect(getJsonPath(body, "$a")).toBeUndefined();
    expect(getJsonPath(body, "a..b")).toBeUndefined();
    expect(getJsonPath(body, "a[x]")).toBeUndefined();
    expect(getJsonPath(body, "a[0")).toBeUndefined();
  });
});
