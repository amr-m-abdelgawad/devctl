import { act, createElement } from "react";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { paletteFor } from "../themes.ts";
import { JsonView } from "./JsonView.tsx";

const PANE_WIDTH = 36;
const PANE_HEIGHT = 16;
const LONG = "W".repeat(90);

function assertFitsPane(frame: string, width: number): void {
  for (const line of frame.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(width);
  }
}

async function renderJson(input: unknown, compact: boolean) {
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      createElement(JsonView, {
        palette: paletteFor("devctl"),
        input,
        compact,
      }),
      { width: PANE_WIDTH, height: PANE_HEIGHT },
    );
  });
  await setup.renderOnce();
  return setup;
}

describe("JsonView wrap", () => {
  test("wraps a long raw string inside the pane", async () => {
    const setup = await renderJson(LONG, true);
    try {
      const frame = setup.captureCharFrame();
      expect(frame.replaceAll(/\s/g, "")).toContain(LONG);
      assertFitsPane(frame, PANE_WIDTH);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("wraps a long pretty JSON string inside the pane", async () => {
    const setup = await renderJson({ token: LONG }, true);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("token");
      expect(frame.replaceAll(/\s/g, "")).toContain(LONG);
      assertFitsPane(frame, PANE_WIDTH);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("wraps a long JSON tree value inside the pane", async () => {
    const setup = await renderJson({ token: LONG }, false);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("token");
      expect(frame).toContain("WWWWWWWW");
      assertFitsPane(frame, PANE_WIDTH);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
