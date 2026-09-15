import { describe, expect, test } from "bun:test";
import { emptyHttpClientAuth, emptyHttpClientRequest, flattenTree, requestCount, type HttpClientCollection } from "./request.ts";

describe("http client collection helpers", () => {
  test("counts and flattens request items", () => {
    const request = emptyHttpClientRequest();
    request.id = "health";
    request.name = "Health";
    request.method = "GET";
    const collection: HttpClientCollection = {
      id: "demo",
      name: "demo",
      source: "bruno",
      path: "",
      readonly: true,
      vars: [],
      headers: [],
      auth: emptyHttpClientAuth(),
      items: [{ kind: "request", id: "health", request }],
      environments: [],
    };
    expect(requestCount(collection.items)).toBe(1);
    expect(flattenTree(collection).some((row) => row.requestId === "health")).toBe(true);
  });
});
