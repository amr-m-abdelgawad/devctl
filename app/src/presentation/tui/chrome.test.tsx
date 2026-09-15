import { act, createElement } from "react";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { UserNotification } from "../../domain/notifications.ts";
import { paletteFor } from "./themes.ts";
import { NoticeBar } from "./chrome.tsx";

const NOTICE: UserNotification = {
  id: "update:0.10.0",
  kind: "update",
  title: "New version available",
  body: "0.9.0 → 0.10.0",
  hint: "Install with /update.",
  severity: "info",
  primaryLabel: "Update",
};

describe("NoticeBar", () => {
  test("shows the version range and the three actions", async () => {
    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(
        createElement(NoticeBar, {
          palette: paletteFor("devctl"),
          notice: NOTICE,
          width: 80,
          onAction: () => undefined,
        }),
        { width: 80, height: 3 },
      );
    });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("New version available");
      expect(frame).toContain("0.9.0 → 0.10.0");
      expect(frame).toContain("Update");
      expect(frame).toContain("Later");
      expect(frame).toContain("Dismiss");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
