import { describe, expect, test } from "bun:test";
import { uptimeLabel } from "./format.ts";

describe("uptimeLabel", () => {
  test("keeps minutes once the span reaches hours", () => {
    expect(uptimeLabel(19 * 3_600_000 + 4 * 60_000)).toBe("19h 4m");
    expect(uptimeLabel(2 * 3_600_000)).toBe("2h 0m");
    expect(uptimeLabel(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(uptimeLabel(12 * 60_000)).toBe("12m");
    expect(uptimeLabel(5_000)).toBe("5s");
  });
});
