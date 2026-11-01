import { describe, expect, test } from "bun:test";
import { handleOverlayKey } from "./keyboard-overlays.ts";
import type { OverlayKeyCtx } from "./keyboard-context.ts";

function excludeCtx(index: number) {
  const calls = { toggled: [] as string[], cleared: 0, closed: 0, index };
  const ctx = {
    overlay: "log-exclude",
    tui: { keybinds: {} },
    logExcludeOptions: ["api", "web", "worker"],
    logExcludeIndex: index,
    setLogExcludeIndex: (update: number | ((i: number) => number)) => {
      calls.index = typeof update === "function" ? update(calls.index) : update;
    },
    toggleExcludedLogService: (name: string) => calls.toggled.push(name),
    clearExcludedLogServices: () => {
      calls.cleared += 1;
    },
    closeOverlay: () => {
      calls.closed += 1;
    },
  } as unknown as OverlayKeyCtx;
  return { ctx, calls };
}

describe("log exclude overlay keys", () => {
  test("space and enter toggle the selected service and leave it open", () => {
    const { ctx, calls } = excludeCtx(1);
    expect(handleOverlayKey(ctx, { name: "space" })).toBe("handled");
    expect(handleOverlayKey(ctx, { name: "return" })).toBe("handled");
    expect(calls.toggled).toEqual(["web", "web"]);
    expect(calls.closed).toBe(0);
  });

  test("the cursor stops at both ends of the list", () => {
    const { ctx, calls } = excludeCtx(2);
    handleOverlayKey(ctx, { name: "down" });
    expect(calls.index).toBe(2);
    for (let i = 0; i < 4; i += 1) {
      handleOverlayKey(ctx, { name: "k" });
    }
    expect(calls.index).toBe(0);
  });

  test("c clears and esc closes", () => {
    const { ctx, calls } = excludeCtx(0);
    handleOverlayKey(ctx, { name: "c" });
    handleOverlayKey(ctx, { name: "escape" });
    expect(calls).toMatchObject({ cleared: 1, closed: 1, toggled: [] });
  });
});
