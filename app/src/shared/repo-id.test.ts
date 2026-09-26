import { describe, expect, test } from "bun:test";
import { INSTANCE_NAME_PATTERN, repoID } from "./repo-id.ts";

describe("repoID", () => {
  test("the default instance keeps the checkout's id; a named one gets its own", () => {
    const own = repoID("/src/app");
    expect(repoID("/src/app", "")).toBe(own);
    expect(repoID("/src/app/")).toBe(own);
    expect(repoID("/src/app", "ci-7")).not.toBe(own);
    expect(repoID("/src/app", "ci-7")).toBe(repoID("/src/app/", "ci-7"));
    expect(repoID("/src/app", "ci-8")).not.toBe(repoID("/src/app", "ci-7"));
  });

  test("instance names are short lowercase slugs", () => {
    for (const ok of ["ci-7", "a", "review_42", "0abc"]) {
      expect(INSTANCE_NAME_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ["", "-lead", "Upper", "has space", "a/b", "x".repeat(33)]) {
      expect(INSTANCE_NAME_PATTERN.test(bad)).toBe(false);
    }
  });
});
