import { leaderAction, lookupCommand } from "../commands.ts";
import { TRACE_SPAN_PAGE } from "../helpers/traces.ts";
import { pageScrollAmount } from "../helpers/chrome.ts";
import { selectedSlashCommand, slashCompleteQuery } from "../helpers/command-catalog.ts";
import { isCommandChord, isPageDownKey, isPageUpKey, overlayConsumesTyping, type KeyLike } from "../keymap.ts";
import { hasPrimaryMod } from "../tui-config.ts";
import { scrollBoxBy } from "../layout.tsx";
import { HELP_SCROLL_PAGE } from "../overlays/Help.tsx";
import { THEME_NAMES } from "../themes.ts";
import { requestIdOf } from "../../../domain/logs/logs.ts";
import type { OverlayKeyCtx } from "./keyboard-context.ts";

function openCommandOverlay(ctx: OverlayKeyCtx): void {
  ctx.setQuery("");
  ctx.setSlashIndex(0);
  ctx.setSlashPicker("commands");
  ctx.setOverlay("slash");
}

/** Returns true when an overlay consumed the key (including swallowing leftover keys). */
export function handleOverlayKey(ctx: OverlayKeyCtx, key: KeyLike): boolean {
  const {
    overlay, tui, height, closeOverlay, confirmKind, onQuit, confirmAction, planBusy,
    logDetailsScrollRef, traceScrollRef, traceDetailScrollRef, scrollTextScrollRef, routeDetailsScrollRef, planScrollRef, helpScrollRef,
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
  if (overlay === "span-details") {
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return true;
    }
    if (name === "escape") {
      ctx.setOverlay("trace");
      return true;
    }
    if (name === "down" || name === "j") {
      scrollBoxBy(traceDetailScrollRef.current, tui.scroll_speed);
      return true;
    }
    if (name === "up" || name === "k") {
      scrollBoxBy(traceDetailScrollRef.current, -tui.scroll_speed);
      return true;
    }
    if (isPageDownKey(key)) {
      scrollBoxBy(traceDetailScrollRef.current, pageScrollAmount(height));
      return true;
    }
    if (isPageUpKey(key)) {
      scrollBoxBy(traceDetailScrollRef.current, -pageScrollAmount(height));
      return true;
    }
    return true;
  }
  if (overlay === "log-details" || overlay === "scroll-text" || overlay === "trace") {
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return true;
    }
    if (name === "escape") {
      closeOverlay();
      return true;
    }
    if (overlay === "log-details" && name === "return") {
      const traceId = ctx.logDetail?.traceId?.trim() ?? "";
      if (traceId !== "") {
        ctx.openTrace(traceId);
        return true;
      }
      const id = ctx.logDetail ? requestIdOf(ctx.logDetail).trim() : "";
      if (id !== "") {
        ctx.setLogSearch(id);
        ctx.setScreen("logs");
        ctx.closeOverlay();
        ctx.setStatus(`tracing ${id}`);
      }
      return true;
    }
    if (overlay === "trace" && name === "return") {
      ctx.openSpanLogs();
      return true;
    }
    if (overlay === "trace" && (name === "down" || name === "j")) {
      ctx.setTraceSpanIndex((index) => Math.min(Math.max(0, ctx.traceSpanCount - 1), index + 1));
      return true;
    }
    if (overlay === "trace" && (name === "up" || name === "k")) {
      ctx.setTraceSpanIndex((index) => Math.max(0, index - 1));
      return true;
    }
    const box = overlay === "log-details" ? logDetailsScrollRef.current : overlay === "trace" ? traceScrollRef.current : scrollTextScrollRef.current;
    if (overlay !== "trace" && (name === "down" || name === "j")) {
      scrollBoxBy(box, tui.scroll_speed);
      return true;
    }
    if (overlay !== "trace" && (name === "up" || name === "k")) {
      scrollBoxBy(box, -tui.scroll_speed);
      return true;
    }
    if (isPageDownKey(key)) {
      if (overlay === "trace") {
        ctx.setTraceSpanIndex((index) => Math.min(Math.max(0, ctx.traceSpanCount - 1), index + TRACE_SPAN_PAGE));
        return true;
      }
      scrollBoxBy(box, pageScrollAmount(height));
      return true;
    }
    if (isPageUpKey(key)) {
      if (overlay === "trace") {
        ctx.setTraceSpanIndex((index) => Math.max(0, index - TRACE_SPAN_PAGE));
        return true;
      }
      scrollBoxBy(box, -pageScrollAmount(height));
      return true;
    }
    return true;
  }
  if (overlay === "route-details") {
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return true;
    }
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
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return true;
    }
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
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return true;
    }
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
    if (isCommandChord(key, tui)) {
      revertThemePreview();
      openCommandOverlay(ctx);
      return true;
    }
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
    if (isCommandChord(key, tui)) {
      if (leaderTimer.current) {
        clearTimeout(leaderTimer.current);
      }
      openCommandOverlay(ctx);
      return true;
    }
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
        setQuery(slashCompleteQuery(pick));
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
