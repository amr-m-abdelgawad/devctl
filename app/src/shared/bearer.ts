import { timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

export function bearerMatches(header: string, token: string): boolean {
  if (token === "" || !header.startsWith(BEARER_PREFIX)) {
    return false;
  }
  const presented = Buffer.from(header.slice(BEARER_PREFIX.length));
  const expected = Buffer.from(token);
  if (presented.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(presented, expected);
}
