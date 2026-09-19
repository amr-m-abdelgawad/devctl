import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, emptyRouteAuth, emptyService } from "../../domain/config/types.ts";
import { emptyRuntime, HealthHealthy, StateRunning } from "../../domain/service/services.ts";
import { type StatusSnapshot } from "../../domain/status.ts";
import { buildSnapshot, emptyIdentitySnapshot, formatStatusFromSnapshot, routeIapCredentialsValid, type SnapshotHost } from "./snapshot.ts";

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

function hostFromConfig(cfg: ReturnType<typeof defaultConfig>): SnapshotHost {
  return {
    sessionID: "sess",
    cfg,
    profile: "",
    runtimes: new Map(),
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

describe("route credentials_valid", () => {
  test("is undefined without an IAP credentials file and true/false when checked", () => {
    expect(routeIapCredentialsValid(emptyRouteAuth())).toBeUndefined();
    expect(routeIapCredentialsValid({ ...emptyRouteAuth(), type: "iap" })).toBeUndefined();
    expect(routeIapCredentialsValid({ ...emptyRouteAuth(), type: "iap", credentials: "/no/such/devctl-iap.json" })).toBe(false);

    const path = join(process.env.TMPDIR ?? "/tmp", `devctl-snap-iap-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ type: "authorized_user", client_id: "cid", refresh_token: "rt" }));
    expect(routeIapCredentialsValid({ ...emptyRouteAuth(), type: "iap", client_id: "cid", credentials: path })).toBe(true);
    expect(routeIapCredentialsValid({ ...emptyRouteAuth(), type: "iap", client_id: "other", credentials: path })).toBe(false);
  });

  test("buildSnapshot copies credentials_valid onto IAP routes with a credentials file", () => {
    const path = join(process.env.TMPDIR ?? "/tmp", `devctl-snap-route-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ type: "authorized_user", client_id: "cid", refresh_token: "rt" }));
    const cfg = defaultConfig();
    cfg.services.api = emptyService();
    cfg.proxy.routes = [
      {
        name: "none",
        match: { host: "none.local", path: "" },
        upstream: { url: "http://127.0.0.1:1" },
        auth: { ...emptyRouteAuth(), type: "none" },
      },
      {
        name: "iap",
        match: { host: "iap.local", path: "" },
        upstream: { url: "https://example.com" },
        auth: { ...emptyRouteAuth(), type: "iap", client_id: "cid", credentials: path },
      },
    ];
    const snap = buildSnapshot(hostFromConfig(cfg));
    expect(snap.proxy.routes?.[0]?.credentials_valid).toBeUndefined();
    expect(snap.proxy.routes?.[1]?.credentials_valid).toBe(true);
    expect(snap.proxy.routes?.[1]?.client_id).toBe("cid");
  });
});
