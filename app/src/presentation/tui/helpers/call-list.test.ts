import { describe, expect, test } from "bun:test";
import { pinnedCallIndex, stepCallIndex } from "./call-list.ts";

describe("pinnedCallIndex", () => {
  const calls = [{ id: "new" }, { id: "mid" }, { id: "old" }];

  test("follows the newest row until the user pins an id", () => {
    expect(pinnedCallIndex(calls, undefined)).toBe(0);
    expect(pinnedCallIndex([], undefined)).toBe(0);
  });

  test("keeps the pinned id when newer rows prepend", () => {
    expect(pinnedCallIndex(calls, "mid")).toBe(1);
    expect(pinnedCallIndex([{ id: "newer" }, ...calls], "mid")).toBe(2);
  });

  test("returns -1 when the pinned id has aged out", () => {
    expect(pinnedCallIndex(calls, "gone")).toBe(-1);
  });
});

describe("stepCallIndex", () => {
  test("clamps within the list and treats a missing pin as the newest row", () => {
    expect(stepCallIndex(0, 0, 1)).toBe(0);
    expect(stepCallIndex(3, -1, 1)).toBe(1);
    expect(stepCallIndex(3, 0, 1)).toBe(1);
    expect(stepCallIndex(3, 2, 1)).toBe(2);
    expect(stepCallIndex(3, 1, -1)).toBe(0);
    expect(stepCallIndex(3, 0, -1)).toBe(0);
  });
});
