import { describe, expect, test } from "bun:test";
import { parseBruEnvironment, parseBruRequest } from "./bru.ts";

const health = `meta {
  name: Health
  type: http
  seq: 1
}

get {
  url: {{baseUrl}}/health
}

headers {
  Accept: application/json
}
`;

describe("Bruno parser adapter", () => {
  test("normalizes a .bru request into the domain model", () => {
    const request = parseBruRequest(health, "health", "health");
    expect(request.name).toBe("Health");
    expect(request.method).toBe("GET");
    expect(request.url).toBe("{{baseUrl}}/health");
    expect(request.headers).toEqual([{ name: "Accept", value: "application/json", enabled: true }]);
  });

  test("parses environment vars", () => {
    const vars = parseBruEnvironment("vars {\n  baseUrl: http://127.0.0.1:3999\n  stolen: ${token}\n}\n");
    expect(vars).toEqual([
      { name: "baseUrl", value: "http://127.0.0.1:3999", enabled: true },
      { name: "stolen", value: "${token}", enabled: true },
    ]);
  });
});
