import { describe, expect, test } from "bun:test";
import { asHttpSendInput } from "./decode.ts";
import { parseRequestRef, prettyHttpBody } from "./request.ts";

describe("asHttpSendInput", () => {
  test("accepts snake_case keys and inline headers as a map", () => {
    const input = asHttpSendInput({
      collection_id: "devctl",
      request_id: "service:api",
      insecure_attach_token: true,
      inline: {
        method: "post",
        url: "https://example.test/echo",
        headers: { "X-Trace": "1" },
        body: { mode: "json", text: "{\"ok\":true}" },
        params: [{ name: "q", value: "1", kind: "query" }],
      },
    });
    expect(input.collectionId).toBe("devctl");
    expect(input.requestId).toBe("service:api");
    expect(input.insecureAttachToken).toBe(true);
    expect(input.inline?.method).toBe("POST");
    expect(input.inline?.headers).toEqual([{ name: "X-Trace", value: "1", enabled: true }]);
    expect(input.inline?.body.mode).toBe("json");
    expect(input.inline?.params[0]?.name).toBe("q");
  });
});

describe("parseRequestRef", () => {
  test("splits collection/request and rejects incomplete paths", () => {
    expect(parseRequestRef("devctl/service:api")).toEqual({ collectionId: "devctl", requestId: "service:api" });
    expect(parseRequestRef("sample-collection/folder/echo")).toEqual({ collectionId: "sample-collection", requestId: "folder/echo" });
    expect(parseRequestRef("nope")).toBeUndefined();
    expect(parseRequestRef("/only")).toBeUndefined();
  });
});

describe("prettyHttpBody", () => {
  test("pretty-prints JSON and leaves other bodies alone", () => {
    expect(prettyHttpBody("{\"a\":1}")).toBe("{\n  \"a\": 1\n}");
    expect(prettyHttpBody("not json")).toBe("not json");
  });
});
