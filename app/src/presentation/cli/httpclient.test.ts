import { describe, expect, test } from "bun:test";
import { emptyHttpClientAuth, emptyHttpClientRequest, type HttpClientCollection } from "../../domain/httpclient/request.ts";
import { formatHttpList, formatHttpSendResult } from "./httpclient.ts";

describe("http client CLI formatting", () => {
  test("lists collection/request paths", () => {
    const request = emptyHttpClientRequest();
    request.id = "health";
    request.name = "Health";
    request.method = "GET";
    const collection: HttpClientCollection = {
      id: "sample-collection",
      name: "Fixture API",
      source: "bruno",
      path: "sample-collection",
      readonly: true,
      vars: [],
      headers: [],
      auth: emptyHttpClientAuth(),
      items: [{ kind: "request", id: "health", request }],
      environments: [],
    };
    const text = formatHttpList([collection]);
    expect(text).toContain("sample-collection/health");
    expect(text).toContain("GET");
  });

  test("prints status, timing, and pretty JSON", () => {
    const text = formatHttpSendResult({
      id: "http-1",
      url: "http://127.0.0.1:3999/health",
      tokenDecision: "attach",
      authAttached: true,
      response: {
        status: 200,
        statusText: "OK",
        headers: [{ name: "content-type", value: "application/json", enabled: true }],
        body: "{\"ok\":true}",
        size: 11,
        durationMs: 4,
        truncated: false,
      },
    });
    expect(text).toContain("200 OK");
    expect(text).toContain("token:attached");
    expect(text).toContain('"ok": true');
  });
});
