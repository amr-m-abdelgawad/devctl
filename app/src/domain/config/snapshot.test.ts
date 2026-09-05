import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./types.ts";
import { configSnapshotDiff, replaceSnapshot } from "./snapshot.ts";

describe("config snapshot", () => {
  test("replaceSnapshot returns the new object", () => {
    const prev = defaultConfig();
    const next = defaultConfig();
    next.project.name = "other";
    expect(replaceSnapshot(prev, next)).toBe(next);
  });

  test("diff marks command changes as restart required", () => {
    const prev = defaultConfig();
    prev.services.api = emptyService();
    prev.services.api.command = { args: ["old"], shell: false };
    const next = defaultConfig();
    next.services.api = emptyService();
    next.services.api.command = { args: ["new"], shell: false };
    const diff = configSnapshotDiff(prev, next);
    expect(diff.restart_required).toContain("api");
    expect(diff.changes.api).toContain("command");
  });
});
