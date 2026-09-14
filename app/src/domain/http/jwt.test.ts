import { describe, expect, test } from "bun:test";
import { jwtExpiry } from "./jwt.ts";

function jwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("jwtExpiry", () => {
  test("reads exp from a JWT payload", () => {
    expect(jwtExpiry(jwt(1_700_000_000))?.getTime()).toBe(1_700_000_000_000);
    expect(jwtExpiry("not-a-jwt")).toBeUndefined();
  });
});
