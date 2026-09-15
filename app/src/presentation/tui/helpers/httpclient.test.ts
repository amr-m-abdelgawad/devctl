import { describe, expect, test } from "bun:test";
import { filterHttpTree, methodTone, nextPane, nextTab, HTTP_REQUEST_TABS } from "./httpclient.ts";
import type { HttpClientTreeRow } from "../../../domain/httpclient/request.ts";

describe("http client tui helpers", () => {
  test("filters tree rows by name or method", () => {
    const rows: HttpClientTreeRow[] = [
      { depth: 0, kind: "collection", id: "devctl", collectionId: "devctl", name: "devctl", readonly: true },
      { depth: 1, kind: "request", id: "devctl/service:api", collectionId: "devctl", requestId: "service:api", name: "api", method: "GET", readonly: true },
      { depth: 1, kind: "request", id: "devctl/recipe:login", collectionId: "devctl", requestId: "recipe:login", name: "login", method: "POST", readonly: true },
    ];
    expect(filterHttpTree(rows, "post").map((row) => row.requestId)).toEqual(["recipe:login"]);
    expect(filterHttpTree(rows, "").length).toBe(3);
  });

  test("cycles panes and request tabs", () => {
    expect(nextPane("tree", 1)).toBe("request");
    expect(nextPane("response", 1)).toBe("tree");
    expect(nextTab(HTTP_REQUEST_TABS, "params", 1)).toBe("headers");
    expect(methodTone("GET")).toBe("success");
    expect(methodTone("DELETE")).toBe("error");
  });
});
