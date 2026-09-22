import { describe, expect, test } from "bun:test";
import { applyRequestBodyReplacements, invalidBodyReplacement, REQUEST_BODY_TRANSFORM_MAX_BYTES } from "./body-transform.ts";

describe("request body transform", () => {
  test("replaces every literal occurrence and leaves dots literal", () => {
    const body = '{"a":"http://127.0.0.1:8080/x","b":"http://127.0.0.1:8080/y","c":"http://127X0X0X1:8080"}';
    const out = applyRequestBodyReplacements(body, [
      { replace: "http://127.0.0.1:8080", with: "https://remote.example.com", regex: false },
    ]);
    expect(out).toBe('{"a":"https://remote.example.com/x","b":"https://remote.example.com/y","c":"http://127X0X0X1:8080"}');
  });

  test("inserts with literally, including $", () => {
    const out = applyRequestBodyReplacements("pre-TOKEN-post", [
      { replace: "TOKEN", with: "$$1", regex: false },
    ]);
    expect(out).toBe("pre-$$1-post");
  });

  test("applies rules in order", () => {
    const out = applyRequestBodyReplacements("http://127.0.0.1:PORT", [
      { replace: "PORT", with: "8080", regex: false },
      { replace: "http://127.0.0.1:8080", with: "https://remote.example.com", regex: false },
    ]);
    expect(out).toBe("https://remote.example.com");
  });

  test("regex replaces every match and does not expand $ in with", () => {
    const out = applyRequestBodyReplacements("go http://127.0.0.1:9/a and http://127.0.0.1:10/b", [
      { replace: "http://127\\.0\\.0\\.1:\\d+", with: "https://remote.example.com", regex: true },
    ]);
    expect(out).toBe("go https://remote.example.com/a and https://remote.example.com/b");
  });

  test("rejects an empty pattern and a regex that matches empty", () => {
    expect(invalidBodyReplacement({ replace: "", with: "x", regex: false }, 0)).toBe(
      "transform.request_body[0].replace is empty",
    );
    expect(invalidBodyReplacement({ replace: ".*", with: "x", regex: true }, 1)).toBe(
      "transform.request_body[1].replace matches an empty string",
    );
    expect(() => applyRequestBodyReplacements("abc", [{ replace: "(", with: "x", regex: true }])).toThrow(
      /not a valid regular expression/,
    );
  });

  test("caps a transformed body at 16 MiB", () => {
    expect(REQUEST_BODY_TRANSFORM_MAX_BYTES).toBe(16 * 1024 * 1024);
  });
});
