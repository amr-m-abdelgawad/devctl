import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveDaemonTarget, scanStateDirsForRepoRoot } from "./daemon.ts";
import { writePersistedState } from "./storage.ts";

function tmp(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-daemon-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = join(dir, "home");
  return dir;
}

function fixtureState(repoRoot: string) {
  return { session_id: "s", repo_root: repoRoot, profile: "", processes: [] };
}

describe("scanStateDirsForRepoRoot", () => {
  test("finds a repo_root that is an ancestor of the target directory", () => {
    tmp();
    writePersistedState("/fake/repo/a", fixtureState("/fake/repo/a"));
    expect(scanStateDirsForRepoRoot("/fake/repo/a/nested/deep")).toBe("/fake/repo/a");
    expect(scanStateDirsForRepoRoot("/fake/repo/a")).toBe("/fake/repo/a");
  });

  test("prefers the longest (most specific) matching repo_root", () => {
    tmp();
    writePersistedState("/fake/repo", fixtureState("/fake/repo"));
    writePersistedState("/fake/repo/nested", fixtureState("/fake/repo/nested"));
    expect(scanStateDirsForRepoRoot("/fake/repo/nested/deep")).toBe("/fake/repo/nested");
  });

  test("does not match an unrelated directory or a sibling with a shared prefix", () => {
    tmp();
    writePersistedState("/fake/repo-one", fixtureState("/fake/repo-one"));
    expect(scanStateDirsForRepoRoot("/fake/repo-two")).toBeUndefined();
    // "/fake/repo-one-extra" must not match "/fake/repo-one" just because
    // the strings share a prefix — only real path-segment ancestry counts.
    expect(scanStateDirsForRepoRoot("/fake/repo-one-extra")).toBeUndefined();
  });

  test("skips malformed state.json entries instead of throwing", () => {
    const dir = tmp();
    const stateRoot = join(dir, "home", "state");
    mkdirSync(join(stateRoot, "garbage"), { recursive: true });
    writeFileSync(join(stateRoot, "garbage", "state.json"), "{ not valid json");
    writePersistedState("/fake/repo/a", fixtureState("/fake/repo/a"));
    expect(scanStateDirsForRepoRoot("/fake/repo/a")).toBe("/fake/repo/a");
  });

  test("returns undefined when no state directory exists at all", () => {
    tmp();
    expect(scanStateDirsForRepoRoot("/anywhere")).toBeUndefined();
  });
});

describe("resolveDaemonTarget", () => {
  test("an explicit --repo wins outright, without touching discovery", () => {
    tmp();
    expect(resolveDaemonTarget("", "/explicit/path")).toEqual({ repoRoot: "/explicit/path", source: "explicit" });
  });

  test("prefers normal .devctl discovery when it succeeds", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(join(dir, ".devctl", "config.yaml"), "version: 1\n");
    expect(resolveDaemonTarget(dir, "")).toEqual({ repoRoot: dir, source: "config" });
  });

  test("falls back to the state-directory scan when .devctl is gone", () => {
    const dir = tmp();
    // No .devctl here at all — simulates a deleted configuration — but a
    // daemon's persisted state for this exact directory still exists.
    writePersistedState(dir, fixtureState(dir));
    expect(resolveDaemonTarget(dir, "")).toEqual({ repoRoot: dir, source: "state-scan" });
  });

  test("returns undefined when neither discovery nor the scan finds anything", () => {
    const dir = tmp();
    expect(resolveDaemonTarget(dir, "")).toBeUndefined();
  });
});
