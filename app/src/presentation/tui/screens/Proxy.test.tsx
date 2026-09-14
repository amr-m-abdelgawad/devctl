import { act, createElement } from "react";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ProxyRequestSnapshot, StatusSnapshot } from "../../../domain/status.ts";
import { paletteFor } from "../themes.ts";
import { ProxyScreen } from "./Proxy.tsx";

const LONG_PATH = "/api/v1/invoices/fulfill/cache-miss-then-policy-check-then-billing-authorize";

function snapshot(requests: ProxyRequestSnapshot[]): StatusSnapshot {
  return {
    session_id: "s",
    repo_root: "/r",
    profile: "local",
    services: {},
    proxy: {
      running: true,
      address: "127.0.0.1:18080",
      routes: [{ name: "invoices", identity: "", upstream: "http://127.0.0.1:8080", auth: "none" }],
      requestTotal: requests.length,
      requestErrors: 0,
      recentRequests: requests,
    },
    identity: { user: "", project: "", project_source: "", adc: false, service_accounts: {}, service_account_status: {}, iap: false },
    logs: { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 },
    system: { platform: "test", cpuCount: 1, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, memTotalKB: 0, memFreeKB: 0, memAvailableKB: 0, hostUptimeSec: 0 },
  };
}

describe("ProxyScreen requests", () => {
  test("path wraps and shows request duration plus proxy hop", async () => {
    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(
        createElement(ProxyScreen, {
          palette: paletteFor("devctl"),
          snap: snapshot([
            {
              timestamp: "2026-09-14T12:00:00.000Z",
              requestId: "r1",
              method: "GET",
              path: LONG_PATH,
              route: "invoices",
              identity: "user",
              status: 200,
              durationMs: 12,
              traceDurationMs: 142,
            },
          ]),
          width: 110,
        }),
        { width: 110, height: 22 },
      );
    });
    await setup.renderOnce();
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("REQ");
      expect(frame).toContain("HOP");
      expect(frame).toContain("142ms");
      expect(frame).toContain("12ms");
      expect(frame).toContain("/api/v1/invoice");
      expect(frame).toContain("fulfill");
      expect(frame).toContain("authorize");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("without a trace the hop is labeled and the path still wraps", async () => {
    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(
        createElement(ProxyScreen, {
          palette: paletteFor("devctl"),
          snap: snapshot([
            {
              timestamp: "2026-09-14T12:00:00.000Z",
              requestId: "r2",
              method: "POST",
              path: LONG_PATH,
              route: "invoices",
              identity: "",
              status: 201,
              durationMs: 74,
            },
          ]),
          width: 110,
        }),
        { width: 110, height: 22 },
      );
    });
    await setup.renderOnce();
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("74ms");
      expect(frame).toContain("—");
      expect(frame).not.toContain("142ms");
      expect(frame).toContain("fulfill");
      expect(frame).toContain("authorize");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
