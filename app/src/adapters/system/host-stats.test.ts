import { describe, expect, test } from "bun:test";
import { parseDarwinVmStat, parseLinuxMeminfo, readHostMemory } from "./host-stats.ts";

describe("host memory", () => {
  test("reads MemAvailable from Linux meminfo", () => {
    const text = ["MemTotal:       16384000 kB", "MemFree:         1024000 kB", "MemAvailable:    6291456 kB", ""].join("\n");
    expect(parseLinuxMeminfo(text)).toBe(6_291_456);
    expect(parseLinuxMeminfo("MemTotal: 1 kB\n")).toBeUndefined();
  });

  test("treats free + inactive + speculative + purgeable as leftover on macOS", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               1000.",
      "Pages active:                             9000.",
      "Pages inactive:                           2000.",
      "Pages speculative:                         250.",
      "Pages wired down:                         3000.",
      "Pages purgeable:                           250.",
      "",
    ].join("\n");
    const pages = 1000 + 2000 + 250 + 250;
    expect(parseDarwinVmStat(text)).toBe(Math.round((pages * 16384) / 1024));
    expect(parseDarwinVmStat("no page size here")).toBeUndefined();
  });

  test("live host leftover is between 0 and installed RAM", () => {
    const mem = readHostMemory();
    expect(mem.totalKB).toBeGreaterThan(0);
    expect(mem.leftoverKB).toBeGreaterThanOrEqual(0);
    expect(mem.leftoverKB).toBeLessThanOrEqual(mem.totalKB);
    expect(mem.unusedKB).toBeLessThanOrEqual(mem.totalKB);
  });
});
