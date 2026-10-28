import { describe, expect, test } from "bun:test";
import { callDetailStale, frozenCallListStart, nextCallListFreeze, pinnedCallIndex, selectionScrollKey, stepCallIndex, withCallDetail } from "./call-list.ts";

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

describe("selected call detail", () => {
  const rows = [
    { id: "a", seq: 3, body: "" },
    { id: "b", seq: 2, body: "" },
  ];

  test("swaps the fetched record into its row and leaves the other rows alone", () => {
    const full = { id: "b", seq: 2, body: "payload" };
    expect(withCallDetail(rows, full)).toEqual([rows[0]!, full]);
    expect(withCallDetail(rows, undefined)).toBe(rows);
    expect(withCallDetail(rows, { id: "gone", seq: 1, body: "x" })).toBe(rows);
  });

  test("keeps showing the held record while the row's newer version is fetched", () => {
    const held = { id: "a", seq: 2, body: "older" };
    expect(withCallDetail(rows, held)[0]).toBe(held);
    expect(callDetailStale(rows[0], held)).toBe(true);
  });

  test("fetches only when nothing is held for the selected row or that row changed", () => {
    expect(callDetailStale(undefined, undefined)).toBe(false);
    expect(callDetailStale({ id: "a", seq: 1 }, undefined)).toBe(true);
    expect(callDetailStale({ id: "a", seq: 1 }, { id: "a", seq: 1 })).toBe(false);
    expect(callDetailStale({ id: "a", seq: 2 }, { id: "a", seq: 1 })).toBe(true);
    expect(callDetailStale({ id: "b", seq: 1 }, { id: "a", seq: 1 })).toBe(true);
  });
});
