import { defaultCopyKeybind, keyMatches, type TuiConfig } from "./tui-config.ts";
import { type Overlay } from "./types.ts";

export const DOUBLE_INTERRUPT_MS = 2000;

export type KeyLike = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  alt?: boolean;
  super?: boolean;
  sequence?: string;
};

export function overlayConsumesTyping(overlay: Overlay): boolean {
  return overlay === "slash" || overlay === "palette";
}

export function isLeaderChord(key: KeyLike, tui: TuiConfig): boolean {
  return keyMatches(key, tui.keybinds.leader ?? "ctrl+x");
}

export function isPaletteChord(key: KeyLike, tui: TuiConfig): boolean {
  return keyMatches(key, tui.keybinds.command_list ?? "ctrl+p");
}

export function isCommandChord(key: KeyLike, tui: TuiConfig): boolean {
  return keyMatches(key, tui.keybinds.command ?? "/") || key.name === "/";
}

export function isHelpChord(key: KeyLike, tui: TuiConfig): boolean {
  return keyMatches(key, tui.keybinds.help ?? "?") || key.sequence === "?";
}

export function isSearchChord(key: KeyLike, tui: TuiConfig): boolean {
  return keyMatches(key, tui.keybinds.search ?? "f");
}

export function isCtrlC(key: KeyLike, tui?: TuiConfig): boolean {
  if (tui && keyMatches(key, tui.keybinds.interrupt ?? "ctrl+c")) {
    return true;
  }
  return key.ctrl === true && (key.name ?? "").toLowerCase() === "c";
}

export function isCopyChord(key: KeyLike, tui: TuiConfig): boolean {
  return keyMatches(key, tui.keybinds.copy ?? defaultCopyKeybind());
}

export function shouldConfirmInterrupt(now: number, armedAt: number, windowMs = DOUBLE_INTERRUPT_MS): boolean {
  return armedAt > 0 && now - armedAt <= windowMs;
}

export function isBound(key: KeyLike, tui: TuiConfig, name: string, fallback: string): boolean {
  return keyMatches(key, tui.keybinds[name] ?? fallback);
}
