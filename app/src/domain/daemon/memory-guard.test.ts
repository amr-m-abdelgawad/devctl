import { describe, expect, test } from "bun:test";
import { memoryGuardUsage, storeBudgetFor } from "./memory-guard.ts";

const MIB = 1024 * 1024;

describe("memory guard inputs", () => {
  test("compares the container working set with its limit, else RSS with host memory", () => {
    expect(memoryGuardUsage({ memoryBytes: 2_000, memoryUsedBytes: 1_500 }, 300)).toEqual({ usedBytes: 1_500, limitBytes: 2_000 });
    expect(memoryGuardUsage({ memoryBytes: 64_000 }, 300)).toEqual({ usedBytes: 300, limitBytes: 64_000 });
  });

  test("the ring keeps its budget when ok, half under shrink, a quarter while shedding", () => {
    expect(storeBudgetFor("ok", 160 * MIB)).toBe(160 * MIB);
    expect(storeBudgetFor("shrink", 160 * MIB)).toBe(80 * MIB);
    expect(storeBudgetFor("shed", 160 * MIB)).toBe(40 * MIB);
    expect(storeBudgetFor("shed", 16 * MIB)).toBe(8 * MIB);
    expect(storeBudgetFor("shrink", 4 * MIB)).toBe(4 * MIB);
  });
});
