import { timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

export function bearerMatches(header: string, token: string): boolean {
  if (token === "" || !header.startsWith(BEARER_PREFIX)) {
    return false;
  }
  return secretMatches(header.slice(BEARER_PREFIX.length), token);
}

export function secretMatches(presented: string, expected: string): boolean {
  if (expected === "") {
    return false;
  }
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
