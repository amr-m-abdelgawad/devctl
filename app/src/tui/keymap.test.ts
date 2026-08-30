import { describe, expect, test } from "bun:test";
import { DOUBLE_INTERRUPT_MS, isCopyChord, isCtrlC, shouldConfirmInterrupt } from "./keymap.ts";
import { defaultTuiConfig } from "./tui-config.ts";

describe("tui keymap", () => {
  test("copy uses the platform shortcut and not ctrl+c on mac", () => {
    const tui = defaultTuiConfig();
    expect(isCopyChord({ name: "c", meta: true }, tui)).toBe(process.platform === "darwin");
    expect(isCopyChord({ name: "c", ctrl: true }, tui)).toBe(process.platform !== "darwin");
    expect(isCtrlC({ name: "c", ctrl: true }, tui)).toBe(true);
    expect(isCtrlC({ name: "c", meta: true }, tui)).toBe(false);
  });

  test("interrupt requires a second press inside the window", () => {
    expect(shouldConfirmInterrupt(1000, 0)).toBe(false);
    expect(shouldConfirmInterrupt(1000, 1000)).toBe(true);
    expect(shouldConfirmInterrupt(1000 + DOUBLE_INTERRUPT_MS, 1000)).toBe(true);
    expect(shouldConfirmInterrupt(1001 + DOUBLE_INTERRUPT_MS, 1000)).toBe(false);
  });
});
