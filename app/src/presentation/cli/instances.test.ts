import { describe, expect, test } from "bun:test";
import { formatInstances } from "./instances.ts";

describe("devctl instances", () => {
  test("lists slots with their offset, checkout, listener ports and status", () => {
    const out = formatInstances([
      { slot: 0, offset: 0, repoRoot: "/src/app", claimedAt: "", status: "running", ports: { proxy: 18080, web: 18900, otlp: 18418 } },
      { slot: 1, offset: 100, repoRoot: "/src/app-review-42", claimedAt: "", status: "missing" },
    ]);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^SLOT\s+OFFSET\s+CHECKOUT\s+PROXY\s+WEB\s+OTLP\s+STATUS$/);
    expect(lines[1]).toMatch(/^0\s+\+0\s+\/src\/app\s+18080\s+18900\s+18418\s+running$/);
    expect(lines[2]).toMatch(/^1\s+\+100\s+\/src\/app-review-42\s+-\s+-\s+-\s+missing \(run `devctl instances prune`\)$/);
  });

  test("says so when no checkout holds a slot", () => {
    expect(formatInstances([])).toBe("no checkouts hold a port slot\n");
  });
});
