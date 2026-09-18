import { describe, expect, test } from "bun:test";
import { frozenCallListStart, nextCallListFreeze, pinnedCallIndex, selectionScrollKey, stepCallIndex } from "./call-list.ts";

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

describe("selectionScrollKey", () => {
  test("stays on the pinned id when a prepend only shifts the index", () => {
    expect(selectionScrollKey(1, "mid")).toBe("mid");
    expect(selectionScrollKey(2, "mid")).toBe("mid");
  });

  test("changes when the user moves to another id", () => {
    expect(selectionScrollKey(1, "mid")).not.toBe(selectionScrollKey(0, "new"));
  });

  test("falls back to the index for lists that are not id-pinned", () => {
    expect(selectionScrollKey(3)).toBe("3");
    expect(selectionScrollKey(0, "")).toBe("0");
    expect(selectionScrollKey(1)).toBe("1");
  });
});

describe("nextCallListFreeze", () => {
  test("tracks the newest head while the viewport is at the top", () => {
    expect(nextCallListFreeze("a", ["n", "a"], true)).toEqual({ frozenId: undefined, headId: "n" });
  });

  test("keeps the previous head frozen so a prepend is omitted from the box", () => {
    expect(nextCallListFreeze("a", ["n", "a", "b"], false)).toEqual({ frozenId: "a", headId: "a" });
    expect(frozenCallListStart(["n", "a", "b"], "a", 2)).toBe(1);
  });

  test("reveals newer rows when the cursor moves above the freeze", () => {
    expect(frozenCallListStart(["n", "a", "b"], "a", 0)).toBe(0);
  });

  test("freezes the current head when there is no previous head", () => {
    expect(nextCallListFreeze(undefined, ["a", "b"], false)).toEqual({ frozenId: "a", headId: "a" });
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
