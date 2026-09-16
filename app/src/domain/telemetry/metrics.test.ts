import { describe, expect, test } from "bun:test";
import { percentile } from "./metrics.ts";

describe("percentile", () => {
  test("returns 0 for an empty sample", () => {
    expect(percentile([], 95)).toBe(0);
  });

  test("nearest-rank across a simple range", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 90)).toBe(90);
    expect(percentile(values, 100)).toBe(100);
  });

  test("does not mutate the input", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});
