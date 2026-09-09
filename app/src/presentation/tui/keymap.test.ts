import { describe, expect, test } from "bun:test";
import { DOUBLE_INTERRUPT_MS, isClearLogsKey, isCopyChord, isCtrlC, isInterruptChord, isPageDownKey, isPageUpKey, isQuitKey, isRestartKey, shouldConfirmInterrupt } from "./keymap.ts";
import { defaultTuiConfig } from "./tui-config.ts";

describe("tui keymap", () => {
  test("the OS copy chord copies and escape is the double-tap interrupt", () => {
    const tui = defaultTuiConfig();
    const apple = process.platform === "darwin";
    expect(isCopyChord({ name: "c", ctrl: true }, tui)).toBe(!apple);
    expect(isCopyChord({ name: "c", meta: true }, tui)).toBe(apple);
    expect(isCopyChord({ name: "c", ctrl: true, shift: true }, tui)).toBe(false);
    expect(isCtrlC({ name: "c", ctrl: true })).toBe(!apple);
    expect(isCtrlC({ name: "c", meta: true })).toBe(apple);
    expect(isInterruptChord({ name: "escape" }, tui)).toBe(true);
    expect(isInterruptChord({ name: "c", ctrl: true }, tui)).toBe(false);
    expect(isInterruptChord({ name: "c", ctrl: true }, { ...tui, keybinds: { ...tui.keybinds, interrupt: "ctrl+c" } })).toBe(false);
    expect(isInterruptChord({ name: "c", meta: true }, { ...tui, keybinds: { ...tui.keybinds, interrupt: "cmd+c" } })).toBe(false);
  });

  test("plain q is a quit key; modifiers are not", () => {
    expect(isQuitKey({ name: "q" })).toBe(true);
    expect(isQuitKey({ name: "Q" })).toBe(true);
    expect(isQuitKey({ name: "q", ctrl: true })).toBe(false);
    expect(isQuitKey({ name: "q", meta: true })).toBe(false);
  });

  test("interrupt requires a second press inside the window", () => {
    expect(shouldConfirmInterrupt(1000, 0)).toBe(false);
    expect(shouldConfirmInterrupt(1000, 1000)).toBe(true);
    expect(shouldConfirmInterrupt(1000 + DOUBLE_INTERRUPT_MS, 1000)).toBe(true);
    expect(shouldConfirmInterrupt(1001 + DOUBLE_INTERRUPT_MS, 1000)).toBe(false);
  });

  test("page keys use the OS modifier plus d/u", () => {
    const apple = process.platform === "darwin";
    expect(isPageDownKey({ name: "pagedown" })).toBe(true);
    expect(isPageDownKey({ name: "d", ctrl: !apple, meta: apple })).toBe(true);
    expect(isPageDownKey({ name: "d" })).toBe(false);
    expect(isPageDownKey({ name: "d", ctrl: apple, meta: !apple })).toBe(false);
    expect(isPageUpKey({ name: "pageup" })).toBe(true);
    expect(isPageUpKey({ name: "u", ctrl: !apple, meta: apple })).toBe(true);
    expect(isPageUpKey({ name: "u" })).toBe(false);
  });

  test("restart is shift+r and remains distinct from refresh", () => {
    expect(isRestartKey({ name: "r", shift: true })).toBe(true);
    expect(isRestartKey({ name: "R", shift: true })).toBe(true);
    expect(isRestartKey({ name: "R" })).toBe(true);
    expect(isRestartKey({ name: "r" })).toBe(false);
  });

  test("clear-logs uses the OS modifier plus l, since plain c already jumps to config", () => {
    const chord = { name: "l", ctrl: process.platform !== "darwin", meta: process.platform === "darwin" };
    expect(isClearLogsKey(chord)).toBe(true);
    expect(isClearLogsKey({ ...chord, name: "L" })).toBe(true);
    expect(isClearLogsKey({ name: "l" })).toBe(false);
    expect(isClearLogsKey({ name: "c", shift: true })).toBe(false);
    expect(isClearLogsKey({ name: "l", ctrl: process.platform === "darwin" })).toBe(false);
  });
});
