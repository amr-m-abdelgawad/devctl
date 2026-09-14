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
});
