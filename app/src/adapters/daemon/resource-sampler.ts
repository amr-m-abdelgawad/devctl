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

function pushRing(ring: Map<string, number[]>, key: string, value: number): void {
  const series = ring.get(key) ?? [];
  series.push(value);
  if (series.length > STATS_RING) {
    series.shift();
  }
  ring.set(key, series);
}

export class ResourceSampler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly cpu: number[] = [];
  private readonly mem: number[] = [];
  // Per-service CPU% and memoryKB history, aligned to the host cpu/mem rings
  // (same STATS_SAMPLE_MS cadence and STATS_RING depth). Latest-only values
  // still live on each Runtime; these rings add the trend the Stats screen draws.
  private readonly serviceCpu = new Map<string, number[]>();
  private readonly serviceMem = new Map<string, number[]>();
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

  // Per-service CPU%/memoryKB trend, one StatsSeries per currently-tracked
  // service. Empty until at least one sample tick has recorded values.
  serviceSeries(): Record<string, StatsSeries> {
    const out: Record<string, StatsSeries> = {};
    for (const [name, cpu] of this.serviceCpu) {
      out[name] = { interval_ms: STATS_SAMPLE_MS, cpu: [...cpu], mem: [...(this.serviceMem.get(name) ?? [])] };
    }
    return out;
  }

  // Runtimes only carry a pid; CPU/memory are sampled out-of-band via `ps`
  // on an interval rather than tracked per state transition, since they
  // change continuously while a process runs.
  async poll(): Promise<void> {
    const sampleTick = this.recordStatsSample();
    const pids: number[] = [];
    for (const rt of this.deps.runtimes().values()) {
      if (rt.pid > 0 && (rt.state === StateRunning || rt.state === StateHealthy || rt.state === StateUnhealthy)) {
        pids.push(rt.pid);
      }
    }
    if (pids.length > 0) {
      const samples = await sampleResourceUsage(pids);
      for (const rt of this.deps.runtimes().values()) {
        const sample = rt.pid > 0 ? samples.get(rt.pid) : undefined;
        if (sample) {
          rt.cpuPercent = sample.cpuPercent;
          rt.memoryKB = sample.memoryKB;
        }
      }
    }
    // Record per-service history on the same cadence as the host series, using
    // the values just refreshed above (a stopped service records 0).
    if (sampleTick) {
      this.recordServiceSamples();
    }
  }

  private recordServiceSamples(): void {
    const present = new Set<string>();
    for (const rt of this.deps.runtimes().values()) {
      present.add(rt.name);
      pushRing(this.serviceCpu, rt.name, rt.cpuPercent ?? 0);
      pushRing(this.serviceMem, rt.name, rt.memoryKB ?? 0);
    }
    // Drop history for services that have left the runtime set (e.g. removed by
    // a config reload) so the rings do not grow without bound.
    for (const key of [...this.serviceCpu.keys()]) {
      if (!present.has(key)) {
        this.serviceCpu.delete(key);
        this.serviceMem.delete(key);
      }
    }
  }

  private recordStatsSample(): boolean {
    const now = this.deps.clock.unixMs();
    if (now - this.lastAt < STATS_SAMPLE_MS) {
      return false;
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
    return true;
  }
}
