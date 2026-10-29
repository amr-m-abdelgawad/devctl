import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { markWedgeReported, readWedge, wedgePath } from "./heartbeat.ts";

describe("the watchdog's wedge record", () => {
  let root = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "devctl-wedge-"));
    previousHome = process.env.DEVCTL_HOME;
    process.env.DEVCTL_HOME = join(root, "home");
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.DEVCTL_HOME;
    } else {
      process.env.DEVCTL_HOME = previousHome;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("reads what the watchdog writes, and keeps who reported it", () => {
    const repo = join(root, "repo");
    expect(readWedge(repo)).toBeUndefined();
    mkdirSync(dirname(wedgePath(repo)), { recursive: true });
    // The worker's own format: `{ pid, at }`.
    writeFileSync(wedgePath(repo), `${JSON.stringify({ pid: 307, at: 1_000 })}\n`);
    const wedge = readWedge(repo);
    expect(wedge).toEqual({ pid: 307, at: 1_000 });
    markWedgeReported(repo, wedge!, 500);
    expect(readWedge(repo)).toEqual({ pid: 307, at: 1_000, reportedBy: 500 });
  });

  test("a damaged record reads as none", () => {
    const repo = join(root, "repo");
    mkdirSync(dirname(wedgePath(repo)), { recursive: true });
    writeFileSync(wedgePath(repo), "{not json");
    expect(readWedge(repo)).toBeUndefined();
    writeFileSync(wedgePath(repo), `${JSON.stringify({ pid: "307" })}\n`);
    expect(readWedge(repo)).toBeUndefined();
  });
});
