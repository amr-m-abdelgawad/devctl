import { describe, expect, test } from "bun:test";
import { takeTokenFromSearch } from "./session.ts";

describe("takeTokenFromSearch", () => {
  test("pulls the token and strips it from the query", () => {
    expect(takeTokenFromSearch("?token=abc&x=1")).toEqual({ token: "abc", nextSearch: "?x=1" });
    expect(takeTokenFromSearch("?token=abc")).toEqual({ token: "abc", nextSearch: "" });
  });

  test("leaves the query alone when no token is present", () => {
    expect(takeTokenFromSearch("?x=1")).toEqual({ token: "", nextSearch: "?x=1" });
    expect(takeTokenFromSearch("")).toEqual({ token: "", nextSearch: "" });
    expect(takeTokenFromSearch("?token=")).toEqual({ token: "", nextSearch: "?token=" });
  });
});
