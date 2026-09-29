import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { ensureStdioDir, readyPath, segmentPath, serviceStdioDir } from "./fifo-segments.ts";
import { resumeServiceStdio } from "./fifo-stdio.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fifo output follower", () => {
  test.skipIf(process.platform === "win32")("lets timers run while segments keep arriving", async () => {
    const root = mkdtempSync(join(tmpdir(), "devctl-follow-"));
    dirs.push(root);
    const total = 400;
    const stdoutDir = join(serviceStdioDir(root, "api"), "stdout");
    ensureStdioDir(stdoutDir);
    ensureStdioDir(join(serviceStdioDir(root, "api"), "stderr"));
    for (let seq = 0; seq < total; seq += 1) {
      writeFileSync(segmentPath(stdoutDir, seq), "x\n");
      writeFileSync(readyPath(stdoutDir, seq), "");
    }
    let consumed = 0;
    let consumedWhenTimerFired = -1;
    setTimeout(() => {
      consumedWhenTimerFired = consumed;
    }, 0);
    let stop = false;
    const follower = resumeServiceStdio(root, "api");
    expect(follower).toBeDefined();
    await follower!.follow(() => {
      consumed += 1;
      if (consumed === total) {
        stop = true;
      }
      return true;
    }, () => false, () => stop);
    expect(consumedWhenTimerFired).toBeGreaterThanOrEqual(0);
    expect(consumedWhenTimerFired).toBeLessThan(total / 2);
  });
});
