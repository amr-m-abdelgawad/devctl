import { describe, expect, test } from "bun:test";
import { autoRingBytes } from "../../../src/domain/logs/budgets.ts";
import { decideLiveness } from "../../../src/domain/daemon/liveness.ts";

const enabled = process.env.DEVCTL_SOAK === "1";

describe.skipIf(!enabled)("resource soak", () => {
  test("decision table and default budgets match the container contract", () => {
    expect(autoRingBytes(2 * 1024 * 1024 * 1024)).toBeGreaterThan(0);
    expect(decideLiveness({ process: "alive", identityMatches: true, lockGeneration: 1 })).toBe("leave-legacy");
    expect(decideLiveness({ process: "dead", identityMatches: false, lockGeneration: 2 })).toBe("spawn");
  });
});
