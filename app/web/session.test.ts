import { describe, expect, test } from "bun:test";
import { takeTokenFromHash } from "./session.ts";

describe("takeTokenFromHash", () => {
  test("pulls the token and strips it from the fragment", () => {
    expect(takeTokenFromHash("#token=abc")).toEqual({ token: "abc", nextHash: "" });
    expect(takeTokenFromHash("token=abc")).toEqual({ token: "abc", nextHash: "" });
  });

  test("leaves a routing fragment alone when no token is present", () => {
    expect(takeTokenFromHash("#/services")).toEqual({ token: "", nextHash: "#/services" });
    expect(takeTokenFromHash("")).toEqual({ token: "", nextHash: "" });
    expect(takeTokenFromHash("#token=")).toEqual({ token: "", nextHash: "#token=" });
  });
});
