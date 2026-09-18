import { act, createElement } from "react";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { StatusSnapshot } from "../../../domain/status.ts";
import type { TrafficCall } from "../../../domain/traffic/traffic.ts";
import { paletteFor } from "../themes.ts";
import { ProxyScreen } from "./Proxy.tsx";

function snapshot(): StatusSnapshot {
  return {
    session_id: "s",
    repo_root: "/r",
    profile: "local",
    services: {},
    proxy: {
      running: true,
      address: "127.0.0.1:18080",
      routes: [{ name: "invoices", identity: "", upstream: "http://127.0.0.1:8080", auth: "none" }],
      requestTotal: 1,
      requestErrors: 0,
      recentRequests: [],
    },
    identity: { user: "", project: "", project_source: "", adc: false, service_accounts: {}, service_account_status: {}, iap: false },
    logs: { total: 0, errors: 0, counts: {}, seen: 0, seenErrors: 0 },
    system: { platform: "test", cpuCount: 1, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, memTotalKB: 0, memFreeKB: 0, memAvailableKB: 0, hostUptimeSec: 0 },
  };
}

function hop(overrides: Partial<TrafficCall> = {}): TrafficCall {
  return {
    seq: 1,
    id: "r1",
    timestamp: "2026-09-14T12:00:00.000Z",
    method: "POST",
    path: "/invoices",
    route: "invoices",
    transport: "http",
    status: 200,
    durationMs: 12,
    attributes: {},
    request: { encoding: "utf8", text: '{\n  "id": 1\n}', contentType: "application/json" },
    response: { encoding: "utf8", text: '{\n  "ok": true\n}', contentType: "application/json" },
    ...overrides,
  };
}

describe("ProxyScreen traffic inspector", () => {
  test("lists a captured hop and shows the JSON body", async () => {
    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(
        createElement(ProxyScreen, {
          palette: paletteFor("devctl"),
          snap: snapshot(),
          page: { calls: [hop()], nextCursor: "", hasNext: false },
          error: "",
          selected: 0,
          width: 120,
          bodyMode: "json",
          onToggleBody: () => undefined,
          onPick: () => undefined,
          onOpen: () => undefined,
        }),
        { width: 120, height: 24 },
      );
    });
    await setup.renderOnce();
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("invoices");
      expect(frame).toContain("POST");
      expect(frame).toContain('"id": 1');
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("empty state mentions inspect.enabled", async () => {
    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(
        createElement(ProxyScreen, {
          palette: paletteFor("devctl"),
          snap: snapshot(),
          page: { calls: [], nextCursor: "", hasNext: false },
          error: "",
          selected: 0,
          width: 110,
          bodyMode: "json",
          onToggleBody: () => undefined,
          onPick: () => undefined,
          onOpen: () => undefined,
        }),
        { width: 110, height: 22 },
      );
    });
    await setup.renderOnce();
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("inspect.enabled");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
