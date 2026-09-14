import { describe, expect, test } from "bun:test";
import { bearerMatches } from "./bearer.ts";

describe("bearerMatches", () => {
  test("accepts an exact Bearer token", () => {
    expect(bearerMatches("Bearer secret-token", "secret-token")).toBe(true);
  });

  test("rejects missing, empty, or wrong credentials", () => {
    expect(bearerMatches("", "secret-token")).toBe(false);
    expect(bearerMatches("Bearer secret-token", "")).toBe(false);
    expect(bearerMatches("Bearer wrong-token", "secret-token")).toBe(false);
    expect(bearerMatches("secret-token", "secret-token")).toBe(false);
    expect(bearerMatches("bearer secret-token", "secret-token")).toBe(false);
  });
});
