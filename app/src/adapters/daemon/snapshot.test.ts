import { describe, expect, test } from "bun:test";
import { emptyRuntime, HealthHealthy, StateRunning } from "../../domain/service/services.ts";
import { type StatusSnapshot } from "../../domain/status.ts";
import { formatStatusFromSnapshot } from "./snapshot.ts";

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

describe("formatStatusFromSnapshot", () => {
  test("includes the selected env column", () => {
    const text = formatStatusFromSnapshot(sampleSnap());
    expect(text).toContain("SERVICE\tSTATUS\tHEALTH\tENV\tPID");
    expect(text).toContain("api\tHEALTHY\tHEALTHY\tdeployed\t42");
  });
});
