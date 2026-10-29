import { describe, expect, test } from "bun:test";
import { withSuspendedRenderer } from "./suspend.ts";
import { type CliRenderer } from "@opentui/core";

// Like OpenTUI's, suspend() and resume() finish a moment after they are called.
function fakeRenderer(): CliRenderer & { calls: string[] } {
  const calls: string[] = [];
  const later = async (done: string): Promise<void> => {
    await Bun.sleep(5);
    calls.push(done);
  };
  return {
    calls,
    suspend: () => later("suspend"),
    resume: () => later("resume"),
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
