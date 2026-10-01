// Finding from the Docker soak suite, pinned here on the real log worker.
//
// The daemon's `status` reports `daemon.logs` from WorkerLogStore's copy of
// the worker's pipeline stats, and that copy is refreshed only by the next
// record or chunk ack. Each record's snapshot is taken as it is published,
// before the session writer's 100 ms batch lands, so when output stops the
// last copy keeps that batch as `spooledBytes` for as long as the service
// stays quiet. In the soak container a 30k-line flood left
// `spooledBytes: 31293` for minutes with an empty spool directory and a
// complete session file. `ingestPaused()` reads `paused` from the same copy.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { gateEnabled, gatedName } from "../../e2e/soak/gates.ts";
import { WorkerLogStore } from "../../src/adapters/storage/worker-log-store.ts";
import { Bus } from "../../src/shared/events.ts";

const RECORDS = 200;

function persistedLines(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line !== "").length;
  } catch {
    return 0;
  }
}

test.skipIf(!gateEnabled("stale-pipeline-stats"))(gatedName("stale-pipeline-stats", "pipeline stats settle once persistence has caught up"), async () => {
  const dir = mkdtempSync(join(tmpdir(), "devctl-stats-"));
  const store = new WorkerLogStore({
    max: 10_000,
    persist: true,
    directory: dir,
    sessionID: "stats",
    retentionDays: 0,
    maxSessionLogs: 0,
    extraMarkers: [],
    extraPatterns: [],
    spoolDir: join(dir, "spool"),
  }, new Bus(16));
  try {
    await store.waitUntilReady(5_000);
    // Structured records commit at once, so every one of them lands inside one writer batch.
    for (let n = 1; n <= RECORDS; n += 1) {
      store.append({ timestamp: new Date().toISOString(), service: "api", source: "devctl", level: "INFO", message: `record ${n}`, pid: 0 });
    }
    const file = join(dir, "session-stats", "api.jsonl");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && persistedLines(file) < RECORDS) {
      await Bun.sleep(50);
    }
    // Every record is on disk, so nothing is spooled or waiting to be written.
    expect(persistedLines(file)).toBe(RECORDS);
    await Bun.sleep(500);
    expect(store.pipelineStats()?.spooledBytes ?? 0).toBe(0);
    expect(store.pipelineStats()?.inFlightBytes ?? 0).toBe(0);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
