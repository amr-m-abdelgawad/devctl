import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../../domain/config/types.ts";
import { emptyRuntime, HealthHealthy, StateRunning } from "../../domain/service/services.ts";
import { type StatusSnapshot } from "../../domain/status.ts";
import { buildSnapshot, emptyIdentitySnapshot, formatStatusFromSnapshot, type SnapshotHost } from "./snapshot.ts";

function sampleSnap(): StatusSnapshot {
  const api = emptyRuntime("api");
  api.state = StateRunning;
  api.health = HealthHealthy;
  api.pid = 42;
  api.env = "deployed";
  api.started_env = "local";
  return {
    session_id: "sess",
    repo_root: "/repo",
    profile: "local",
    services: { api },
    proxy: { running: false, routes: [] },
    identity: {
      user: "dev@example.com",
      project: "demo",
      project_source: "configuration",
      adc: true,
      service_accounts: {},
      service_account_status: {},
      iap: false,
    },
    logs: { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 },
    system: { platform: "test", cpuCount: 1, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, memTotalKB: 0, memFreeKB: 0, memAvailableKB: 0, hostUptimeSec: 0 },
  };
}

function snapshotHost(rt: ReturnType<typeof emptyRuntime>, startPeriodSeconds: number): SnapshotHost {
  const cfg = defaultConfig();
  const svc = emptyService();
  svc.health.start_period_seconds = startPeriodSeconds;
  cfg.services.api = svc;
  return {
    sessionID: "sess",
    cfg,
    profile: "local",
    runtimes: new Map([["api", rt]]),
    ports: new Map(),
    serviceProfile: new Map(),
    serviceEnv: new Map(),
    serviceStartedEnv: new Map(),
    clientEnv: new Map(),
    mcpToken: "",
    mcpDisabledTools: [],
    identityCache: emptyIdentitySnapshot(cfg),
    serviceAccountStatus: new Map(),
    credentialEntries: [],
    detached: false,
    setupMode: false,
    restartRequired: [],
    logs: { snapshot: () => ({ total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 }) },
    tokens: { storeBackend: () => "memory" },
  };
}

describe("buildSnapshot start period", () => {
  test("computes remaining/total at snapshot time and omits them after the window", () => {
    const rt = emptyRuntime("api");
    rt.state = StateRunning;
    rt.startTime = "2026-09-19T00:00:00.000Z";
    const now = Date.parse(rt.startTime) + 2_500;
    const snap = buildSnapshot(snapshotHost(rt, 10), now);
    expect(snap.services.api?.start_period_remaining_ms).toBe(7_500);
    expect(snap.services.api?.start_period_total_ms).toBe(10_000);

    const later = buildSnapshot(snapshotHost(rt, 10), now + 8_000);
    expect(later.services.api?.start_period_remaining_ms).toBeUndefined();
    expect(later.services.api?.start_period_total_ms).toBeUndefined();
  });

  test("does not copy a stale remaining_ms stored on the live runtime", () => {
    const rt = emptyRuntime("api");
    rt.startTime = "2026-09-19T00:00:00.000Z";
    rt.start_period_remaining_ms = 9_999;
    rt.start_period_total_ms = 10_000;
    const elapsed = buildSnapshot(snapshotHost(rt, 10), Date.parse(rt.startTime) + 11_000);
    expect(elapsed.services.api?.start_period_remaining_ms).toBeUndefined();
    expect(elapsed.services.api?.start_period_total_ms).toBeUndefined();
  });
});

describe("formatStatusFromSnapshot", () => {
  test("includes the selected env column", () => {
    const text = formatStatusFromSnapshot(sampleSnap());
    expect(text).toContain("SERVICE\tSTATUS\tHEALTH\tENV\tPID");
    expect(text).toContain("api\tHEALTHY\tHEALTHY\tdeployed\t42");
  });
});
