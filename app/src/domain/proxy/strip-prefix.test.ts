import { describe, expect, test } from "bun:test";
import { stripMatchPrefix } from "./strip-prefix.ts";

describe("stripMatchPrefix", () => {
  test("rewrites the inbound path and keeps the query string", () => {
    expect(stripMatchPrefix("/my-service", "/my-service")).toBe("/");
    expect(stripMatchPrefix("/my-service/foo", "/my-service")).toBe("/foo");
    expect(stripMatchPrefix("/my-service/foo?q=1", "/my-service")).toBe("/foo?q=1");
    expect(stripMatchPrefix("/my-service?q=1", "/my-service")).toBe("/?q=1");
  });

  test("is a no-op when match.path is empty or does not prefix the path", () => {
    expect(stripMatchPrefix("/my-service/foo?q=1", "")).toBe("/my-service/foo?q=1");
    expect(stripMatchPrefix("/other/foo", "/my-service")).toBe("/other/foo");
  });

  test("normalizes a trailing-slash match prefix", () => {
    expect(stripMatchPrefix("/my-service/", "/my-service/")).toBe("/");
    expect(stripMatchPrefix("/my-service/foo", "/my-service/")).toBe("/foo");
  });
});
