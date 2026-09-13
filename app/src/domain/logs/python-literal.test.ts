import { describe, expect, test } from "bun:test";
import { parsePythonLiteral, parsePythonLiteralObject } from "./python-literal.ts";

describe("python mapping literals", () => {
  test("parses Python str(dict) with single quotes", () => {
    const value = parsePythonLiteralObject("{'email': 'unknown', 'response_status': 200}");
    expect(value).toEqual({ email: "unknown", response_status: 200 });
  });

  test("parses nested dicts, lists, bools, and None", () => {
    const value = parsePythonLiteral("{'ok': True, 'empty': None, 'tags': ['a', 'b'], 'user': {'id': 1}}");
    expect(value).toEqual({ ok: true, empty: null, tags: ["a", "b"], user: { id: 1 } });
  });

  test("parses escaped quotes and JSON true/false/null with a trailing comma", () => {
    expect(parsePythonLiteral("{'msg': 'it\\'s ok'}")).toEqual({ msg: "it's ok" });
    expect(parsePythonLiteral(`{"msg": "say \\"hi\\"", "ok": true,}`)).toEqual({ msg: 'say "hi"', ok: true });
  });

  test("accepts identifier keys from JS-style inspect output", () => {
    expect(parsePythonLiteralObject("{ email: 'unknown', count: 2 }")).toEqual({ email: "unknown", count: 2 });
  });

  test("rejects sets, bare text, and leftover trailing tokens", () => {
    expect(parsePythonLiteral("{not valid json}")).toBeUndefined();
    expect(parsePythonLiteral("{1, 2}")).toBeUndefined();
    expect(parsePythonLiteral("{'a': 1} extra")).toBeUndefined();
    expect(parsePythonLiteral("[1, 2]")).toEqual([1, 2]);
    expect(parsePythonLiteralObject("[1, 2]")).toBeUndefined();
  });
});
