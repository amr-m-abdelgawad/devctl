import { type ServiceConfig } from "../../../domain/config/types.ts";
import { type Runtime } from "../../../domain/service/services.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { formatMemoryKB, formatUptime, renderBar } from "./format.ts";
import {
  isActiveRuntime,
  isLiveProcessState,
  SERVICE_COL_GAP,
  SERVICE_CPU_COL,
  SERVICE_HEALTH_COL,
  SERVICE_MEM_COL,
  SERVICE_NAME_MIN,
  SERVICE_PID_COL,
  SERVICE_STATE_COL,
  SERVICE_UPTIME_COL,
} from "./services.ts";

const LOAD_WARN_RATIO = 0.85;

const LOAD_DANGER_RATIO = 1.5;

const LEFTOVER_WARN_RATIO = 0.2;

const LEFTOVER_DANGER_RATIO = 0.1;

const TOP_LOG_SOURCES = 5;

export function countRunning(snap?: StatusSnapshot, names?: string[]): { running: number; total: number } {
  const keys = names ?? Object.keys(snap?.services ?? {});
  const running = keys.filter((name) => isActiveRuntime(snap?.services[name])).length;
  return { running, total: keys.length };
}

export type ServiceFleetStats = {
  total: number;
  live: number;
  running: number;
  starting: number;
  healthy: number;
  failed: number;
  stopping: number;
  stopped: number;
};

export function serviceFleetStats(names: string[], snap?: StatusSnapshot): ServiceFleetStats {
  let running = 0;
  let starting = 0;
  let healthy = 0;
  let failed = 0;
  let stopping = 0;
  let stopped = 0;
  for (const name of names) {
    const rt = snap?.services[name];
    if (rt?.health === "HEALTHY") {
      healthy += 1;
    }
    const state = rt?.state ?? "STOPPED";
    if (state === "FAILED") {
      failed += 1;
    } else if (state === "STOPPING") {
      stopping += 1;
    } else if (state === "STARTING" || state === "RESTARTING") {
      starting += 1;
    } else if (isLiveProcessState(state)) {
      running += 1;
    } else {
      stopped += 1;
    }
  }
  return {
    total: names.length,
    live: running + starting,
    running,
    starting,
    healthy,
    failed,
    stopping,
    stopped,
  };
}

export type ResourceTone = "success" | "warning" | "error";

export function loadPerCpu(load: number, cpuCount: number): number {
  if (!Number.isFinite(load) || !Number.isFinite(cpuCount) || cpuCount <= 0) {
    return 0;
  }
  return load / cpuCount;
}

export function memoryUsedKB(totalKB: number, freeKB: number): number {
  if (!Number.isFinite(totalKB) || !Number.isFinite(freeKB) || totalKB < 0 || freeKB < 0) {
    return 0;
  }
  return Math.max(0, Math.min(totalKB, totalKB - freeKB));
}

export function resourceTone(ratio: number, warn: number, danger: number): ResourceTone {
  if (!Number.isFinite(ratio)) {
    return "success";
  }
  if (ratio > danger) {
    return "error";
  }
  if (ratio > warn) {
    return "warning";
  }
  return "success";
}

export function loadTone(load: number, cpuCount: number): ResourceTone {
  return resourceTone(loadPerCpu(load, cpuCount), LOAD_WARN_RATIO, LOAD_DANGER_RATIO);
}

export function leftoverTone(leftoverKB: number, totalKB: number): ResourceTone {
  const ratio = totalKB > 0 ? leftoverKB / totalKB : 1;
  if (ratio < LEFTOVER_DANGER_RATIO) {
    return "error";
  }
  if (ratio < LEFTOVER_WARN_RATIO) {
    return "warning";
  }
  return "success";
}

export function memoryTone(usedKB: number, totalKB: number): ResourceTone {
  return leftoverTone(Math.max(0, totalKB - usedKB), totalKB);
}

export function formatLoadAvg(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "—";
  }
  return value.toFixed(2);
}

export function formatRatioPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) {
    return "—";
  }
  return `${Math.round(ratio * 100)}%`;
}

export function runtimeUptime(rt: Runtime | undefined, now = Date.now()): string {
  if (!rt?.startTime) {
    return "—";
  }
  const start = new Date(rt.startTime).getTime();
  if (!Number.isFinite(start)) {
    return "—";
  }
  return formatUptime(now - start);
}

export function topLogSources(counts: Record<string, number>, limit = TOP_LOG_SOURCES): [string, number][] {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

export type StatsServiceColumns = {
  name: number;
  health: boolean;
  cpu: boolean;
  mem: boolean;
  up: boolean;
  rst: boolean;
  pid: boolean;
};

const STATS_SHOW_HEALTH = 52;

const STATS_SHOW_CPU = 64;

const STATS_SHOW_MEM = 72;

const STATS_SHOW_UP = 82;

const STATS_SHOW_RST = 90;

const STATS_SHOW_PID = 100;

const STATS_FRAME_BORDER = 2;

const STATS_SECTION_BORDER = 2;

const STATS_SECTION_PAD_X = 2;

const STATS_SCROLLBAR = 1;

export const STATS_RESTARTS_COL = 8;

const FACT_WHAT_MIN = 8;

const FACT_WHAT_MAX = 22;

const FACT_READING_MIN = 6;

const FACT_READING_MAX = 28;

const FACT_MEANING_MIN = 12;

export const STATS_FACT_GAP = 2;

export const STATS_RESOURCE_BAR = 10;

export const STATS_METER_COL = 18;

export function statsPaneWidth(termWidth: number, pad = 1): number {
  return Math.max(24, termWidth - STATS_FRAME_BORDER - pad * 2 - STATS_SECTION_BORDER - STATS_SECTION_PAD_X - STATS_SCROLLBAR);
}

export function statsServiceColumns(width: number): StatsServiceColumns {
  const health = width >= STATS_SHOW_HEALTH;
  const cpu = width >= STATS_SHOW_CPU;
  const mem = width >= STATS_SHOW_MEM;
  const up = width >= STATS_SHOW_UP;
  const rst = width >= STATS_SHOW_RST;
  const pid = width >= STATS_SHOW_PID;
  let used = SERVICE_STATE_COL + SERVICE_COL_GAP;
  if (health) {
    used += SERVICE_HEALTH_COL + SERVICE_COL_GAP;
  }
  if (cpu) {
    used += SERVICE_CPU_COL + SERVICE_COL_GAP;
  }
  if (mem) {
    used += SERVICE_MEM_COL + SERVICE_COL_GAP;
  }
  if (up) {
    used += SERVICE_UPTIME_COL + SERVICE_COL_GAP;
  }
  if (rst) {
    used += STATS_RESTARTS_COL + SERVICE_COL_GAP;
  }
  if (pid) {
    used += SERVICE_PID_COL;
  }
  return { name: Math.max(SERVICE_NAME_MIN, width - used), health, cpu, mem, up, rst, pid };
}

export type ResourceMeter = {
  ratio: number;
  label: string;
};

export function resourceMeter(ratio: number): ResourceMeter {
  const safe = Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
  return { ratio: Math.min(1, safe), label: formatRatioPercent(safe) };
}

export function formatResourceMeter(meter: ResourceMeter, barLen = STATS_RESOURCE_BAR): string {
  return `[${renderBar(meter.ratio, barLen)}] ${meter.label.padStart(4)}`;
}

export type StatsFact = {
  what: string;
  reading: string;
  meaning: string;
  tone?: ResourceTone | "muted" | "text";
  meter?: ResourceMeter;
};

export type FactColumns = {
  what: number;
  reading: number;
  meaning: number;
  meter: number;
};

export function factTableColumns(facts: readonly StatsFact[], width: number): FactColumns {
  const whatNeed = facts.reduce((max, fact) => Math.max(max, fact.what.length), "what".length);
  const readNeed = facts.reduce((max, fact) => Math.max(max, fact.reading.length), "reading".length);
  const meter = facts.some((fact) => fact.meter) ? STATS_METER_COL : 0;
  const gaps = STATS_FACT_GAP * (meter > 0 ? 3 : 2);
  let what = Math.min(FACT_WHAT_MAX, Math.max(FACT_WHAT_MIN, whatNeed));
  let reading = Math.min(FACT_READING_MAX, Math.max(FACT_READING_MIN, readNeed));
  let meaning = width - what - reading - meter - gaps;
  if (meaning < FACT_MEANING_MIN && reading > FACT_READING_MIN) {
    reading = Math.max(FACT_READING_MIN, reading - (FACT_MEANING_MIN - meaning));
    meaning = width - what - reading - meter - gaps;
  }
  if (meaning < FACT_MEANING_MIN && what > FACT_WHAT_MIN) {
    what = Math.max(FACT_WHAT_MIN, what - (FACT_MEANING_MIN - meaning));
    meaning = width - what - reading - meter - gaps;
  }
  return { what, reading, meaning: Math.max(0, meaning), meter };
}

const PROBE_HEALTH = new Set(["http", "tcp", "command"]);

export function usesTrafficHealth(svc?: ServiceConfig): boolean {
  return PROBE_HEALTH.has((svc?.health.type ?? "").toLowerCase());
}

export function platformLabel(id: string): string {
  if (id === "darwin") {
    return "macOS";
  }
  if (id === "win32") {
    return "Windows";
  }
  if (id === "linux") {
    return "Linux";
  }
  return id || "this computer";
}

export function loadCopy(load: number, cpuCount: number): StatsFact {
  const cores = Math.max(1, cpuCount);
  const tone = loadTone(load, cores);
  const reading = tone === "error" ? "overloaded" : tone === "warning" ? "busy" : "not busy";
  const meaning =
    tone === "error"
      ? `${cores} cores are queued up — last minute ${formatLoadAvg(load)}`
      : tone === "warning"
        ? `${cores} cores nearly full — last minute ${formatLoadAvg(load)}`
        : `${cores} cores. Last minute ${formatLoadAvg(load)} (under ${cores} is fine)`;
  return { what: "CPU work", reading, meaning, tone, meter: resourceMeter(loadPerCpu(load, cores)) };
}

export function leftoverCopy(leftoverKB: number, totalKB: number): StatsFact {
  const tone = leftoverTone(leftoverKB, totalKB);
  const reading = `${formatMemoryKB(leftoverKB)} of ${formatMemoryKB(totalKB)}`;
  const meaning =
    tone === "error"
      ? "Almost no RAM left for new work"
      : tone === "warning"
        ? "RAM is getting tight"
        : "RAM the computer can still give out";
  const used = totalKB > 0 ? Math.max(0, (totalKB - leftoverKB) / totalKB) : 0;
  return { what: "RAM leftover", reading, meaning, tone, meter: resourceMeter(used) };
}

export function serviceStatusLabel(rt?: Runtime): string {
  const state = rt?.state ?? "STOPPED";
  if (state === "FAILED") {
    return "crashed";
  }
  if (state === "STOPPING") {
    return "stopping";
  }
  if (state === "STARTING" || state === "RESTARTING") {
    return "starting";
  }
  if (isLiveProcessState(state)) {
    return "up";
  }
  return "off";
}

export function serviceCheckLabel(rt?: Runtime): string {
  if (!rt || !isLiveProcessState(rt.state)) {
    return "—";
  }
  if (rt.health === "HEALTHY") {
    return "ready";
  }
  if (rt.health === "UNHEALTHY") {
    return "failing";
  }
  if (rt.state === "STARTING" || rt.state === "RESTARTING") {
    return "waiting";
  }
  return "checking";
}

export function credentialStoreLabel(backend: string): string {
  if (backend === "keychain") {
    return "password store";
  }
  if (backend === "file") {
    return "local file";
  }
  return backend || "unknown store";
}

export function fleetFacts(stats: ServiceFleetStats, probes: boolean): StatsFact[] {
  const rows: StatsFact[] = [
    {
      what: "Started",
      reading: String(stats.live),
      meaning: stats.live === 0 ? "nothing is running yet" : "process is up",
      tone: stats.live > 0 ? "success" : "muted",
    },
  ];
  if (probes) {
    rows.push({
      what: "Ready",
      reading: String(stats.healthy),
      meaning: stats.live === 0 ? "start services first" : "passed their health check",
      tone: stats.live > 0 && stats.healthy < stats.live ? "warning" : stats.healthy > 0 ? "success" : "muted",
    });
  }
  if (stats.starting > 0) {
    rows.push({
      what: "Still starting",
      reading: String(stats.starting),
      meaning: "not ready for traffic yet",
      tone: "warning",
    });
  }
  if (stats.stopping > 0) {
    rows.push({
      what: "Stopping",
      reading: String(stats.stopping),
      meaning: "shutting down",
      tone: "warning",
    });
  }
  rows.push({
    what: "Crashed",
    reading: String(stats.failed),
    meaning: stats.failed > 0 ? "open the service for the error" : "none",
    tone: stats.failed > 0 ? "error" : "muted",
  });
  rows.push({
    what: "Not started",
    reading: String(stats.stopped),
    meaning: stats.stopped > 0 ? "off until you start them" : "all are up",
    tone: "muted",
  });
  return rows;
}
