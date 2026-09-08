import { leaderAction, lookupCommand } from "../commands.ts";
import { pageScrollAmount } from "../helpers/chrome.ts";
import { selectedSlashCommand } from "../helpers/command-catalog.ts";
import { isPageDownKey, isPageUpKey, overlayConsumesTyping, type KeyLike } from "../keymap.ts";
import { hasPrimaryMod } from "../tui-config.ts";
import { scrollBoxBy } from "../layout.tsx";
import { HELP_SCROLL_PAGE } from "../overlays/Help.tsx";
import { THEME_NAMES } from "../themes.ts";
import type { OverlayKeyCtx } from "./keyboard-context.ts";

/** Returns true when an overlay consumed the key (including swallowing leftover keys). */
export function handleOverlayKey(ctx: OverlayKeyCtx, key: KeyLike): boolean {
  const {
    overlay, tui, height, closeOverlay, confirmKind, onQuit, confirmAction, planBusy,
    logDetailsScrollRef, scrollTextScrollRef, routeDetailsScrollRef, planScrollRef, helpScrollRef,
    revertThemePreview, setPaletteIndex, setThemeName, paletteIndex, applyTheme, leaderTimer,
    setOverlay, runCommand, setConfigEditError, saveConfigBuffer, setSlashIndex, filtered,
    setQuery, slashIndex, submitSlash, advanceWizard,
  } = ctx;
  const name = (key.name ?? "").toLowerCase();
  if (overlay === "none") {
    return false;
  }
  if (overlay === "setup-wizard") {
    if (name === "escape") {
      closeOverlay();
      return true;
    }
    if (name === "return") {
      advanceWizard?.();
      return true;
    }
    return overlayConsumesTyping(overlay);
  }
  if (overlay === "confirm") {
    if (name === "escape") {
      closeOverlay();
      return true;
    }
    if (confirmKind === "quit" && name === "d") {
      onQuit(true);
      return true;
    }
    if (confirmKind === "quit" && name === "k") {
      ctx.onDown(true);
      return true;
    }
    if (confirmKind === "restart-cascade" && name === "c") {
      confirmAction("cascade");
      return true;
    }
    if (name === "return") {
      confirmAction();
    }
    return true;
  }
  if (overlay === "log-details" || overlay === "scroll-text") {
    if (name === "escape") {
      closeOverlay();
      return true;
    }
    if (overlay === "log-details" && name === "return") {
      const id = ctx.logDetail?.request_id?.trim() ?? "";
      if (id !== "") {
        ctx.setLogSearch(id);
        ctx.setScreen("logs");
        ctx.closeOverlay();
        ctx.setStatus(`tracing ${id}`);
      }
      return true;
    }
    const box = overlay === "log-details" ? logDetailsScrollRef.current : scrollTextScrollRef.current;
    if (name === "down" || name === "j") {
      scrollBoxBy(box, tui.scroll_speed);
      return true;
    }
    if (name === "up" || name === "k") {
      scrollBoxBy(box, -tui.scroll_speed);
      return true;
    }
    if (isPageDownKey(key)) {
      scrollBoxBy(box, pageScrollAmount(height));
      return true;
    }
    if (isPageUpKey(key)) {
      scrollBoxBy(box, -pageScrollAmount(height));
      return true;
    }
    return true;
  }
  if (overlay === "route-details") {
    if (name === "escape" || name === "return") {
      closeOverlay();
      return true;
    }
    if (name === "down" || name === "j") {
      scrollBoxBy(routeDetailsScrollRef.current, tui.scroll_speed);
      return true;
    }
    if (name === "up" || name === "k") {
      scrollBoxBy(routeDetailsScrollRef.current, -tui.scroll_speed);
      return true;
    }
    return true;
  }
  if (overlay === "plan") {
    if (name === "escape" || (name === "return" && !planBusy)) {
      closeOverlay();
      return true;
    }
    if (name === "down" || name === "j") {
      scrollBoxBy(planScrollRef.current, tui.scroll_speed);
      return true;
    }
    if (name === "up" || name === "k") {
      scrollBoxBy(planScrollRef.current, -tui.scroll_speed);
      return true;
    }
    return true;
  }
  if (overlay === "help") {
    if (name === "escape") {
      closeOverlay();
      return true;
    }
    if (name === "down" || name === "j") {
      scrollBoxBy(helpScrollRef.current, 1);
      return true;
    }
    if (name === "up" || name === "k") {
      scrollBoxBy(helpScrollRef.current, -1);
      return true;
    }
    if (name === "pagedown" || isPageDownKey(key)) {
      scrollBoxBy(helpScrollRef.current, HELP_SCROLL_PAGE);
      return true;
    }
    if (name === "pageup" || isPageUpKey(key)) {
      scrollBoxBy(helpScrollRef.current, -HELP_SCROLL_PAGE);
      return true;
    }
    return true;
  }
  if (overlay === "themes") {
    if (name === "escape") {
      revertThemePreview();
      closeOverlay();
      return true;
    }
    if (name === "down" || name === "j") {
      setPaletteIndex((i) => {
        const next = Math.min(i + 1, THEME_NAMES.length - 1);
        const theme = THEME_NAMES[next];
        if (theme) {
          setThemeName(theme);
        }
        return next;
      });
      return true;
    }
    if (name === "up" || name === "k") {
      setPaletteIndex((i) => {
        const next = Math.max(0, i - 1);
        const theme = THEME_NAMES[next];
        if (theme) {
          setThemeName(theme);
        }
        return next;
      });
      return true;
    }
    if (name === "return") {
      const theme = THEME_NAMES[paletteIndex % THEME_NAMES.length];
      if (theme) {
        applyTheme(theme);
      }
    }
    return true;
  }
  if (overlay === "leader") {
    if (leaderTimer.current) {
      clearTimeout(leaderTimer.current);
    }
    setOverlay("none");
    const action = leaderAction(name);
    const spec = action ? lookupCommand(action) : undefined;
    if (spec) {
      void runCommand(spec, []);
    }
    return true;
  }
  if (overlay === "config-edit") {
    if (name === "escape") {
      setConfigEditError("");
      closeOverlay();
      return true;
    }
    if (hasPrimaryMod(key) && name === "s") {
      saveConfigBuffer();
      return true;
    }
    return true;
  }
  if (overlayConsumesTyping(overlay)) {
    if (name === "escape") {
      closeOverlay();
      return true;
    }
    if (overlay === "slash" && name === "down") {
      setSlashIndex((i) => Math.min(Math.max(filtered.length - 1, 0), i + 1));
      return true;
    }
    if (overlay === "slash" && name === "up") {
      setSlashIndex((i) => Math.max(0, i - 1));
      return true;
    }
    if (overlay === "slash" && name === "tab") {
      if (key.shift) {
        setSlashIndex((i) => Math.max(0, i - 1));
        return true;
      }
      const pick = selectedSlashCommand(filtered, slashIndex);
      if (pick) {
        setQuery(`${pick.name} `);
      }
      return true;
    }
    if (overlay === "slash" && name === "return") {
      submitSlash();
      return true;
    }
    return true;
  }
  return true;
}
