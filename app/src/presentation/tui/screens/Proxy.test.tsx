import { act, createElement } from "react";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { StatusSnapshot } from "../../../domain/status.ts";
import type { TrafficCall } from "../../../domain/traffic/traffic.ts";
import type { TrafficBodyMode } from "../helpers/traffic.ts";
import { paletteFor } from "../themes.ts";
import { ProxyScreen } from "./Proxy.tsx";

const LONG_TOKEN = `WRAPTOKEN${"x".repeat(160)}`;

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

async function renderProxy(opts: { hop?: TrafficCall; bodyMode?: TrafficBodyMode; caller?: string; width?: number; height?: number }) {
  const width = opts.width ?? 120;
  const height = opts.height ?? 24;
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      createElement(ProxyScreen, {
        palette: paletteFor("devctl"),
        snap: snapshot(),
        page: { calls: opts.hop ? [opts.hop] : [], nextCursor: "", hasNext: false },
        error: "",
        caller: opts.caller ?? "",
        selected: 0,
        width,
        bodyMode: opts.bodyMode ?? "json",
        onToggleBody: () => undefined,
        onPick: () => undefined,
        onOpen: () => undefined,
      }),
      { width, height },
    );
  });
  await setup.renderOnce();
  return setup;
}

function assertFitsTerminal(frame: string, width: number): void {
  for (const line of frame.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(width);
  }
}

describe("ProxyScreen traffic inspector", () => {
  test("lists a captured hop and shows the JSON body", async () => {
    const setup = await renderProxy({ hop: hop() });
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("invoices");
      expect(frame).toContain("POST");
      expect(frame).toContain('"id": 1');
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("pretty JSON bodies wrap instead of overflowing the pane", async () => {
    const width = 120;
    const setup = await renderProxy({
      hop: hop({
        request: { encoding: "utf8", text: JSON.stringify({ token: LONG_TOKEN }, null, 2), contentType: "application/json" },
        response: { encoding: "utf8", text: '{"ok":true}', contentType: "application/json" },
      }),
      bodyMode: "json",
      width,
    });
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("routes");
      expect(frame).toContain("traffic");
      expect(frame).toContain("invoices");
      expect(frame.replaceAll(/\s/g, "")).toContain("WRAPTOKEN");
      assertFitsTerminal(frame, width);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("raw bodies wrap instead of overflowing the pane", async () => {
    const width = 120;
    const setup = await renderProxy({
      hop: hop({
        request: { encoding: "utf8", text: LONG_TOKEN, data: LONG_TOKEN, contentType: "text/plain" },
        response: { encoding: "utf8", text: "ok", data: "ok", contentType: "text/plain" },
      }),
      bodyMode: "raw",
      width,
    });
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("routes");
      expect(frame).toContain("traffic");
      expect(frame).toContain("invoices");
      expect(frame.replaceAll(/\s/g, "")).toContain("WRAPTOKEN");
      assertFitsTerminal(frame, width);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("empty state mentions inspect.enabled", async () => {
    const setup = await renderProxy({ width: 110, height: 22 });
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("inspect.enabled");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("caller filter empty state names the service", async () => {
    const setup = await renderProxy({ caller: "billing", width: 110, height: 22 });
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("No hops match this filter");
      expect(frame).toContain("caller: billing");
      expect(frame).toContain("/caller");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
