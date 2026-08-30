import { describe, expect, test } from "bun:test";
import { COMMAND_PROBE_MS, hasCommand } from "./google.ts";

describe("google probes", () => {
  test("hasCommand returns false quickly for a missing binary", async () => {
    const started = Date.now();
    expect(await hasCommand("devctl-missing-binary-9f3c2")).toBe(false);
    expect(Date.now() - started).toBeLessThan(COMMAND_PROBE_MS);
  });
});
