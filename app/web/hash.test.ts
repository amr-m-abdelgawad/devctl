import { describe, expect, test } from "bun:test";
import { hrefFor, parseHash } from "./hash.ts";

describe("web hash routes", () => {
  test("parses the HTTP client route", () => {
    expect(parseHash("#/api")).toEqual({ name: "api" });
    expect(hrefFor("api")).toBe("#/api");
  });
});
