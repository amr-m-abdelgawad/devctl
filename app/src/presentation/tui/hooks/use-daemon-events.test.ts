import { expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { Controller } from "../../../application/client-runtime.ts";
import { logRecord, type LogEvent, type LogPage, type LogPageRequest } from "../../../domain/logs/logs.ts";
import { defaultTuiConfig } from "../../../domain/ui/preferences.ts";
import { newEvent, ServiceHealthChanged, type BusEvent } from "../../../shared/events.ts";
import { useDaemonEvents } from "./use-daemon-events.ts";
import { useLogView } from "./use-log-view.ts";

async function mountHook<P, T>(hook: (props: P) => T, initial: P) {
  let current: T;
  function Harness() {
    const [props] = useState(initial);
    current = hook(props);
    return null;
  }
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(createElement(Harness), { width: 40, height: 5 });
  });
  return {
    get value() {
      return current!;
    },
    async close() {
      await act(async () => setup.renderer.destroy());
    },
  };
}

const rows = (from: number, to: number): LogEvent[] =>
  Array.from({ length: to - from + 1 }, (_, i) => logRecord({ seq: from + i, service: "api", message: `m${from + i}`, timestamp: "2026-01-01T00:00:00.000Z" }));

function page(events: LogEvent[], prevCursor: string): LogPage {
  return { events, prevCursor, hasPrev: prevCursor !== "", nextCursor: "", hasNext: false, sessionChanged: false };
}

test("a status-bearing event refreshes status within the coalescing window, and a flood at most four times a second", async () => {
  let deliver: (event: BusEvent) => void = () => undefined;
  const controller = {
    onEvent: (handler: (event: BusEvent) => void) => {
      deliver = handler;
      return () => undefined;
    },
  } as unknown as Controller;
  let refreshes = 0;
  const mounted = await mountHook(useDaemonEvents, {
    controller,
    paused: false,
    logSince: "",
    refresh: async () => {
      refreshes += 1;
      return undefined;
    },
    setLogs: () => undefined,
    setCfg: () => undefined,
    setConfigReloadError: () => undefined,
    setStatus: () => undefined,
  });
  try {
    const sent = performance.now();
    await act(async () => deliver(newEvent(ServiceHealthChanged, "api", { health: "HEALTHY" })));
    await act(async () => {
      while (refreshes === 0 && performance.now() - sent < 1_000) {
        await Bun.sleep(5);
      }
    });
    expect(refreshes).toBe(1);
    // The 2 s period has not come round, and one event costs one refresh.
    expect(performance.now() - sent).toBeLessThan(1_000);
    await act(async () => Bun.sleep(300));
    refreshes = 0;
    const started = performance.now();
    await act(async () => {
      for (let i = 0; i < 40; i += 1) {
        deliver(newEvent(ServiceHealthChanged, "api", { health: "HEALTHY" }));
        await Bun.sleep(15);
      }
    });
    // However long the flood took on a loaded host, starts stay 250 ms apart.
    const elapsed = performance.now() - started;
    expect(refreshes).toBeGreaterThanOrEqual(1);
    expect(refreshes).toBeLessThanOrEqual(1 + Math.floor(elapsed / 250));
  } finally {
    await mounted.close();
  }
});

test("scrolling back past a full window keeps the fetched page, holds the live tail, and reloads it on follow", async () => {
  const requests: LogPageRequest[] = [];
  const controller = {
    logsPage: async (request: LogPageRequest) => {
      requests.push(request);
      if (request.cursor === "c101") {
        return page(rows(51, 100), "c51");
      }
      return page(rows(101, 200), "c101");
    },
    logsStats: async () => ({ total: 0, byService: {}, byLevel: {}, bySource: {} }),
  } as unknown as Controller;
  const mounted = await mountHook(useLogView, {
    controller,
    tui: defaultTuiConfig(),
    names: ["api"],
    screen: "logs" as const,
    refresh: async () => undefined,
    setStatus: () => undefined,
    logCap: 100,
  });
  try {
    await act(async () => {});
    expect(mounted.value.logs.map((row) => row.seq)).toEqual(rows(101, 200).map((row) => row.seq));
    await act(async () => mounted.value.applyLogCursor(0));
    await act(async () => {});
    expect(requests.some((request) => request.cursor === "c101")).toBe(true);
    // The fetched page stays; the newest records went to make room.
    expect(mounted.value.logs.map((row) => row.seq)).toEqual(rows(51, 150).map((row) => row.seq));
    expect(mounted.value.logWindow.start).toBe(50);
    expect(mounted.value.logTailCut).toBe(true);
    await act(async () => mounted.value.jumpToLatestLogs());
    await act(async () => {});
    expect(mounted.value.logTailCut).toBe(false);
    expect(mounted.value.logs.map((row) => row.seq)).toEqual(rows(101, 200).map((row) => row.seq));
  } finally {
    await mounted.close();
  }
});
