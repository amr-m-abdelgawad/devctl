import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  coerceJsonInput,
  formatJsonPath,
  initialCollapsedIds,
  JSON_DEFAULT_EXPAND_DEPTH,
  prettyJson,
  tokenizeJson,
  visibleJsonTree,
} from "./json-view.ts";

const SAMPLE = {
  request: {
    model: "gpt-4o",
    messages: [
      { role: "user", content: "hello" },
      { role: "system", content: "be brief" },
    ],
    stream: false,
  },
  response: {
    choices: [{ message: { role: "assistant", content: "yo" } }],
  },
};

describe("json-view", () => {
  test("pretty-prints objects and leaves invalid text alone", () => {
    expect(prettyJson({ a: 1 })).toBe("{\n  \"a\": 1\n}");
    expect(coerceJsonInput('{"a":1}').kind).toBe("json");
    expect(coerceJsonInput('{"a":1}').pretty).toBe("{\n  \"a\": 1\n}");
    expect(coerceJsonInput('{"a":1}', false)).toEqual({ kind: "text", value: '{"a":1}', pretty: '{"a":1}' });
    expect(coerceJsonInput("not json")).toEqual({ kind: "text", value: "not json", pretty: "not json" });
    expect(coerceJsonInput(undefined).pretty).toBe("");
  });

  test("formats paths and tokenizes pretty JSON", () => {
    expect(formatJsonPath([])).toBe("$");
    expect(formatJsonPath(["response", 0, "message"])).toBe("$.response[0].message");
    expect(formatJsonPath(["a.b"])).toBe('$["a.b"]');
    expect(formatJsonPath(["a", "b"])).toBe("$.a.b");
    const kinds = tokenizeJson('{\n  "a": 1,\n  "ok": true,\n  "missing": null\n}').map((token) => token.kind);
    expect(kinds).toContain("key");
    expect(kinds).toContain("number");
    expect(kinds).toContain("boolean");
    expect(kinds).toContain("null");
    expect(tokenizeJson('{"msg":"hi"}').some((token) => token.kind === "string" && token.text === "\"hi\"")).toBe(true);
  });

  test("collapses deep nodes and expands search hits", () => {
    const collapsed = initialCollapsedIds(SAMPLE, JSON_DEFAULT_EXPAND_DEPTH);
    expect(collapsed.has(JSON.stringify(["request"]))).toBe(false);
    expect(collapsed.has(JSON.stringify(["request", "messages"]))).toBe(true);
    const tree = visibleJsonTree(SAMPLE, { collapsed });
    expect(tree.some((row) => row.pathLabel === "$.request.messages[0]")).toBe(false);
    const found = visibleJsonTree(SAMPLE, { collapsed, needle: "hello" });
    expect(found.some((row) => row.pathLabel === "$.request.messages[0].content" && row.matched)).toBe(true);
    expect(found.some((row) => row.pathLabel === "$.request.messages")).toBe(true);
  });

  test("keeps dotted keys distinct from nested paths", () => {
    const rows = visibleJsonTree({ "a.b": 1, a: { b: 2 } }, { defaultExpandedDepth: 3 });
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(JSON.stringify(["a.b"]));
    expect(ids).toContain(JSON.stringify(["a", "b"]));
    expect(rows.find((row) => row.id === JSON.stringify(["a.b"]))?.pathLabel).toBe('$["a.b"]');
    expect(rows.find((row) => row.id === JSON.stringify(["a", "b"]))?.pathLabel).toBe("$.a.b");
  });

  test("unwraps embedded JSON strings in the tree", () => {
    const rows = visibleJsonTree({ body: "{\"level\":\"error\",\"msg\":\"boom\"}" }, { defaultExpandedDepth: 3 });
    expect(rows.some((row) => row.pathLabel === "$.body.msg" && row.preview.includes("boom"))).toBe(true);
  });

  test("web copy stays in sync with this module", () => {
    const shared = readFileSync(join(import.meta.dir, "json-view.ts"), "utf8");
    const web = readFileSync(join(import.meta.dir, "../../web/json-view.ts"), "utf8");
    expect(web).toBe(shared);
  });
});
