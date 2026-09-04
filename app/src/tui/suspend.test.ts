import { describe, expect, test } from "bun:test";
import { withSuspendedRenderer } from "./suspend.ts";
import { type CliRenderer } from "@opentui/core";

function fakeRenderer(): CliRenderer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    suspend: () => {
      calls.push("suspend");
    },
    resume: () => {
      calls.push("resume");
    },
    intermediateRender: () => {
      calls.push("redraw");
    },
  } as unknown as CliRenderer & { calls: string[] };
}

describe("withSuspendedRenderer", () => {
  test("releases the terminal before work and restores it after", async () => {
    const renderer = fakeRenderer();
    const result = await withSuspendedRenderer(renderer, async () => {
      expect(renderer.calls).toEqual(["suspend"]);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(renderer.calls).toEqual(["suspend", "resume", "redraw"]);
  });

  test("restores the TUI when work throws", async () => {
    const renderer = fakeRenderer();
    await expect(
      withSuspendedRenderer(renderer, async () => {
        throw new Error("gcloud failed");
      }),
    ).rejects.toThrow("gcloud failed");
    expect(renderer.calls).toEqual(["suspend", "resume", "redraw"]);
  });
});
