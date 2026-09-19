import { describe, expect, test } from "bun:test";
import { mergeChipNames } from "./chips.ts";

describe("mergeChipNames", () => {
  test("keeps previously seen services after a filter page shrinks", () => {
    expect(mergeChipNames(["api", "worker", "proxy"], ["api"], ["worker"])).toEqual(["api", "proxy", "worker"]);
  });

  test("drops blanks and sorts", () => {
    expect(mergeChipNames(["INFO", ""], [undefined, "ERROR"])).toEqual(["ERROR", "INFO"]);
  });
});
