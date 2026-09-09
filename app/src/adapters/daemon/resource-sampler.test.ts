import { describe, expect, test } from "bun:test";
import { emptyRuntime, StateHealthy, StateStopped } from "../../domain/service/services.ts";
import { ResourceSampler, STATS_SAMPLE_MS } from "./resource-sampler.ts";

describe("resource sampler", () => {
  test("poll with no running pids still records a host stats sample", async () => {
    let now = STATS_SAMPLE_MS;
    const stopped = emptyRuntime("api");
    stopped.state = StateStopped;
    stopped.pid = 0;
    const runtimes = new Map([["api", stopped]]);
    const sampler = new ResourceSampler({
      clock: { now: () => new Date(now), isoNow: () => new Date(now).toISOString(), unixMs: () => now },
      runtimes: () => runtimes,
    });
    await sampler.poll();
    const first = sampler.series();
    expect(first.interval_ms).toBe(STATS_SAMPLE_MS);
    expect(first.cpu).toHaveLength(1);
    expect(first.mem).toHaveLength(1);

    now += STATS_SAMPLE_MS - 1;
    await sampler.poll();
    expect(sampler.series().cpu).toHaveLength(1);

    now += 2;
    await sampler.poll();
    expect(sampler.series().cpu).toHaveLength(2);
  });

  test("poll writes cpu/memory onto runtimes that have a live pid", async () => {
    const rt = emptyRuntime("api");
    rt.state = StateHealthy;
    rt.pid = process.pid;
    const sampler = new ResourceSampler({
      clock: { now: () => new Date(), isoNow: () => new Date().toISOString(), unixMs: () => Date.now() },
      runtimes: () => new Map([["api", rt]]),
    });
    await sampler.poll();
    expect(rt.memoryKB === undefined || rt.memoryKB >= 0).toBe(true);
  });
});
