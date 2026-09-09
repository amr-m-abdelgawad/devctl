import type { Clock } from "../../ports/clock.ts";
import { StateHealthy, StateRunning, StateUnhealthy, type Runtime } from "../../domain/service/services.ts";
import type { StatsSeries } from "../../domain/status.ts";
import { sampleResourceUsage } from "../process/processes.ts";
import { systemSnapshot } from "./snapshot.ts";

export const RESOURCE_POLL_MS = 3_000;
export const STATS_SAMPLE_MS = 5_000;
const STATS_RING = 60;

export type ResourceSamplerDeps = {
  clock: Clock;
  runtimes: () => Map<string, Runtime>;
};

export class ResourceSampler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly cpu: number[] = [];
  private readonly mem: number[] = [];
  private lastAt = 0;
  private readonly deps: ResourceSamplerDeps;

  constructor(deps: ResourceSamplerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.poll(), RESOURCE_POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  series(): StatsSeries {
    return { interval_ms: STATS_SAMPLE_MS, cpu: [...this.cpu], mem: [...this.mem] };
  }

  // Runtimes only carry a pid; CPU/memory are sampled out-of-band via `ps`
  // on an interval rather than tracked per state transition, since they
  // change continuously while a process runs.
  async poll(): Promise<void> {
    this.recordStatsSample();
    const pids: number[] = [];
    for (const rt of this.deps.runtimes().values()) {
      if (rt.pid > 0 && (rt.state === StateRunning || rt.state === StateHealthy || rt.state === StateUnhealthy)) {
        pids.push(rt.pid);
      }
    }
    if (pids.length === 0) {
      return;
    }
    const samples = await sampleResourceUsage(pids);
    for (const rt of this.deps.runtimes().values()) {
      const sample = rt.pid > 0 ? samples.get(rt.pid) : undefined;
      if (sample) {
        rt.cpuPercent = sample.cpuPercent;
        rt.memoryKB = sample.memoryKB;
      }
    }
  }

  private recordStatsSample(): void {
    const now = this.deps.clock.unixMs();
    if (now - this.lastAt < STATS_SAMPLE_MS) {
      return;
    }
    this.lastAt = now;
    const sys = systemSnapshot();
    const cpu = sys.cpuCount > 0 ? sys.loadAvg1 / sys.cpuCount : 0;
    const mem = sys.memTotalKB > 0 ? 1 - sys.memAvailableKB / sys.memTotalKB : 0;
    this.cpu.push(cpu);
    this.mem.push(mem);
    if (this.cpu.length > STATS_RING) {
      this.cpu.shift();
    }
    if (this.mem.length > STATS_RING) {
      this.mem.shift();
    }
  }
}
