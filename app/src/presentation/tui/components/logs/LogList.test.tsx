import { act, createElement, useState } from "react";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { logRecord } from "../../../../domain/logs/logs.ts";
import { paletteFor } from "../../themes.ts";
import { LogList } from "./LogList.tsx";

const HEADLINE = "invoice fulfill cache miss then policy check then billing authorize";

async function renderLogs(wrapMode: "all" | "clip") {
  const logs = [
    logRecord({
      timestamp: "2026-09-12T12:00:00.000Z",
      service: "telemetry",
      level: "INFO",
      message: HEADLINE,
      source: "otlp",
      seq: 1,
    }),
  ];
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      createElement(LogList, {
        palette: paletteFor("devctl"),
        logs,
        width: 48,
        wrapMode,
        showTimestamps: true,
        showMeta: true,
        follow: false,
      }),
      { width: 48, height: 14 },
    );
  });
  await setup.renderOnce();
  return setup;
}

describe("LogList layout", () => {
  test("wrap-all keeps the full headline visible", async () => {
    const setup = await renderLogs("all");
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("TIME");
      expect(frame).toContain("MESSAGE");
      expect(frame).toContain("authorize");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("clip truncates the headline instead of wrapping it", async () => {
    const setup = await renderLogs("clip");
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("TIME");
      expect(frame).not.toContain("authorize");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});

describe("LogList follow", () => {
  test("one wheel notch up leaves follow and stays off the tail", async () => {
    const tail = "TAIL-MARKER-line";
    const logs = Array.from({ length: 30 }, (_, index) =>
      logRecord({
        timestamp: "2026-09-12T12:00:00.000Z",
        service: "api",
        level: "INFO",
        message: index === 29 ? tail : `line ${index}`,
        source: "stdout",
        seq: index + 1,
      }),
    );
    let left = 0;
    function Harness() {
      const [follow, setFollow] = useState(true);
      return createElement(LogList, {
        palette: paletteFor("devctl"),
        logs,
        width: 60,
        wrapMode: "clip",
        follow,
        showTimestamps: false,
        showMeta: false,
        onLeaveLatest: () => {
          left += 1;
          setFollow(false);
        },
      });
    }
    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(createElement(Harness), { width: 60, height: 8, useMouse: true });
    });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain(tail);
      await act(async () => {
        await setup.mockMouse.scroll(20, 4, "up");
      });
      await setup.renderOnce();
      expect(left).toBe(1);
      expect(setup.captureCharFrame()).not.toContain(tail);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
