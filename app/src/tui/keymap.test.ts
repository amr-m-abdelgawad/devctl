import { describe, expect, test } from "bun:test";
import { DOUBLE_INTERRUPT_MS, isCopyChord, isCtrlC, isPageDownKey, isPageUpKey, isRestartKey, shouldConfirmInterrupt } from "./keymap.ts";
import { defaultTuiConfig } from "./tui-config.ts";

describe("tui keymap", () => {
  test("copy uses the platform shortcut and not ctrl+c", () => {
    const tui = defaultTuiConfig();
    const onMac = process.platform === "darwin";
    expect(isCopyChord({ name: "c", meta: true }, tui)).toBe(onMac);
    expect(isCopyChord({ name: "c", ctrl: true, shift: true }, tui)).toBe(!onMac);
    expect(isCopyChord({ name: "c", ctrl: true }, tui)).toBe(false);
    expect(isCtrlC({ name: "c", ctrl: true }, tui)).toBe(true);
    expect(isCtrlC({ name: "c", meta: true }, tui)).toBe(false);
  });

  test("interrupt requires a second press inside the window", () => {
    expect(shouldConfirmInterrupt(1000, 0)).toBe(false);
    expect(shouldConfirmInterrupt(1000, 1000)).toBe(true);
    expect(shouldConfirmInterrupt(1000 + DOUBLE_INTERRUPT_MS, 1000)).toBe(true);
    expect(shouldConfirmInterrupt(1001 + DOUBLE_INTERRUPT_MS, 1000)).toBe(false);
  });

  test("page keys include ctrl+d and ctrl+u", () => {
    expect(isPageDownKey({ name: "pagedown" })).toBe(true);
    expect(isPageDownKey({ name: "d", ctrl: true })).toBe(true);
    expect(isPageDownKey({ name: "d" })).toBe(false);
    expect(isPageUpKey({ name: "pageup" })).toBe(true);
    expect(isPageUpKey({ name: "u", ctrl: true })).toBe(true);
    expect(isPageUpKey({ name: "u" })).toBe(false);
  });

  test("restart is shift+r and remains distinct from refresh", () => {
    expect(isRestartKey({ name: "r", shift: true })).toBe(true);
    expect(isRestartKey({ name: "R", shift: true })).toBe(true);
    expect(isRestartKey({ name: "R" })).toBe(true);
    expect(isRestartKey({ name: "r" })).toBe(false);
  });
});
