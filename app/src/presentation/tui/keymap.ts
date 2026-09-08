import { defaultCopyKeybind, hasPrimaryMod, keyMatches, withMod, type TuiConfig } from "./tui-config.ts";
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
  return overlay === "slash" || overlay === "config-edit" || overlay === "setup-wizard";
}

export function isLeaderChord(key: KeyLike, tui: TuiConfig): boolean {
  return keyMatches(key, tui.keybinds.leader ?? withMod("x"));
}

export function isPaletteChord(key: KeyLike, tui: TuiConfig): boolean {
  return keyMatches(key, tui.keybinds.command_list ?? withMod("p"));
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

export function isRestartKey(key: KeyLike): boolean {
  const name = key.name ?? "";
  return name === "R" || (key.shift === true && name.toLowerCase() === "r");
}

// Plain "c" already jumps to the config screen (see isBound(key, tui, "config", "c")). The OS
// modifier + L sidesteps that — none of the screen-jump bindings expect cmd/ctrl — and matches
// the classic terminal "clear" chord.
export function isClearLogsKey(key: KeyLike): boolean {
  return hasPrimaryMod(key) && (key.name ?? "").toLowerCase() === "l";
}

export function isCtrlC(key: KeyLike): boolean {
  return hasPrimaryMod(key) && (key.name ?? "").toLowerCase() === "c";
}

export function isInterruptChord(key: KeyLike, tui: TuiConfig): boolean {
  const bind = (tui.keybinds.interrupt ?? "escape").toLowerCase();
  // The OS copy chord must not quit. A leftover interrupt: ctrl+c / cmd+c in tui.json is ignored.
  const effective = bind === "ctrl+c" || bind === "cmd+c" ? "escape" : bind;
  return keyMatches(key, effective);
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

export function isPageDownKey(key: KeyLike): boolean {
  const name = (key.name ?? "").toLowerCase();
  return name === "pagedown" || (hasPrimaryMod(key) && name === "d");
}

export function isPageUpKey(key: KeyLike): boolean {
  const name = (key.name ?? "").toLowerCase();
  return name === "pageup" || (hasPrimaryMod(key) && name === "u");
}
