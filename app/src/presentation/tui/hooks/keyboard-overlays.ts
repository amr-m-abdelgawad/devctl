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

export type OverlayKeyFate = "handled" | "pass" | "none";

/** `handled` stops the key from reaching a focused widget. `pass` skips screen
 * shortcuts but lets the focused input or textarea receive the key. */
export function handleOverlayKey(ctx: OverlayKeyCtx, key: KeyLike): OverlayKeyFate {
  const {
    overlay, tui, height, closeOverlay, confirmKind, onQuit, confirmAction, planBusy,
    logDetailsScrollRef, traceScrollRef, traceDetailScrollRef, scrollTextScrollRef, routeDetailsScrollRef, planScrollRef, helpScrollRef,
    revertThemePreview, setPaletteIndex, setThemeName, paletteIndex, applyTheme, leaderTimer,
    setOverlay, runCommand, setConfigEditError, saveConfigBuffer, setSlashIndex, filtered,
    setQuery, slashIndex, submitSlash, advanceWizard, envOptions, envIndex, setEnvIndex, applyEnv,
  } = ctx;
  const name = (key.name ?? "").toLowerCase();
  if (overlay === "none") {
    return "none";
  }
  if (overlay === "setup-wizard") {
    if (name === "escape") {
      closeOverlay();
      return "handled";
    }
    if (name === "return") {
      advanceWizard?.();
      return "handled";
    }
    return "pass";
  }
  if (overlay === "confirm") {
    if (name === "escape") {
      closeOverlay();
      return "handled";
    }
    if (confirmKind === "quit" && name === "d") {
      onQuit(true);
      return "handled";
    }
    if (confirmKind === "quit" && name === "k") {
      ctx.onDown(true);
      return "handled";
    }
    if (confirmKind === "restart-cascade" && name === "c") {
      confirmAction("cascade");
      return "handled";
    }
    if (confirmKind === "env-restart" && name === "r") {
      confirmAction("restart");
      return "handled";
    }
    if (name === "return") {
      confirmAction();
    }
    return "handled";
  }
  if (overlay === "span-details") {
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return "handled";
    }
    if (name === "escape") {
      ctx.setOverlay("trace");
      return "handled";
    }
    if (name === "down" || name === "j") {
      scrollBoxBy(traceDetailScrollRef.current, tui.scroll_speed);
      return "handled";
    }
    if (name === "up" || name === "k") {
      scrollBoxBy(traceDetailScrollRef.current, -tui.scroll_speed);
      return "handled";
    }
    if (isPageDownKey(key)) {
      scrollBoxBy(traceDetailScrollRef.current, pageScrollAmount(height));
      return "handled";
    }
    if (isPageUpKey(key)) {
      scrollBoxBy(traceDetailScrollRef.current, -pageScrollAmount(height));
      return "handled";
    }
    return "handled";
  }
  if (overlay === "log-details" || overlay === "llm-details" || overlay === "traffic-details" || overlay === "scroll-text" || overlay === "trace") {
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return "handled";
    }
    if (name === "escape") {
      closeOverlay();
      return "handled";
    }
    if (overlay === "log-details" && name === "return") {
      // Follow the whole request when the log line carries a request id: this
      // seeds the logs filter and opens the trace in one move. Fall back to the
      // trace id alone when no request id is present.
      const id = ctx.logDetail ? requestIdOf(ctx.logDetail).trim() : "";
      if (id !== "") {
        ctx.openRequest(id);
        return "handled";
      }
      const traceId = ctx.logDetail?.traceId?.trim() ?? "";
      if (traceId !== "") {
        ctx.openTrace(traceId);
      }
      return "handled";
    }
    if (overlay === "llm-details" && name === "return") {
      const traceId = ctx.llmDetail?.traceId?.trim() ?? "";
      if (traceId !== "") {
        ctx.openTrace(traceId);
      }
      return "handled";
    }
    if (overlay === "llm-details" && name === "r") {
      ctx.toggleLlmBodyMode();
      return "handled";
    }
    if (overlay === "traffic-details" && name === "return") {
      const traceId = ctx.trafficDetail?.traceId?.trim() ?? "";
      if (traceId !== "") {
        ctx.openTrace(traceId);
      }
      return "handled";
    }
    if (overlay === "traffic-details" && name === "r") {
      ctx.toggleTrafficBodyMode();
      return "handled";
    }
    if (overlay === "trace" && name === "return") {
      ctx.openSpanLogs();
      return "handled";
    }
    if (overlay === "trace" && (name === "down" || name === "j")) {
      ctx.setTraceSpanIndex((index) => Math.min(Math.max(0, ctx.traceSpanCount - 1), index + 1));
      return "handled";
    }
    if (overlay === "trace" && (name === "up" || name === "k")) {
      ctx.setTraceSpanIndex((index) => Math.max(0, index - 1));
      return "handled";
    }
    const box = overlay === "log-details" || overlay === "llm-details" || overlay === "traffic-details" ? logDetailsScrollRef.current : overlay === "trace" ? traceScrollRef.current : scrollTextScrollRef.current;
    if (overlay !== "trace" && (name === "down" || name === "j")) {
      scrollBoxBy(box, tui.scroll_speed);
      return "handled";
    }
    if (overlay !== "trace" && (name === "up" || name === "k")) {
      scrollBoxBy(box, -tui.scroll_speed);
      return "handled";
    }
    if (isPageDownKey(key)) {
      if (overlay === "trace") {
        ctx.setTraceSpanIndex((index) => Math.min(Math.max(0, ctx.traceSpanCount - 1), index + TRACE_SPAN_PAGE));
        return "handled";
      }
      scrollBoxBy(box, pageScrollAmount(height));
      return "handled";
    }
    if (isPageUpKey(key)) {
      if (overlay === "trace") {
        ctx.setTraceSpanIndex((index) => Math.max(0, index - TRACE_SPAN_PAGE));
        return "handled";
      }
      scrollBoxBy(box, -pageScrollAmount(height));
      return "handled";
    }
    return "handled";
  }
  if (overlay === "route-details") {
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return "handled";
    }
    if (name === "escape" || name === "return") {
      closeOverlay();
      return "handled";
    }
    if (name === "down" || name === "j") {
      scrollBoxBy(routeDetailsScrollRef.current, tui.scroll_speed);
      return "handled";
    }
    if (name === "up" || name === "k") {
      scrollBoxBy(routeDetailsScrollRef.current, -tui.scroll_speed);
      return "handled";
    }
    return "handled";
  }
  if (overlay === "plan") {
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return "handled";
    }
    if (name === "escape" || (name === "return" && !planBusy)) {
      closeOverlay();
      return "handled";
    }
    if (name === "down" || name === "j") {
      scrollBoxBy(planScrollRef.current, tui.scroll_speed);
      return "handled";
    }
    if (name === "up" || name === "k") {
      scrollBoxBy(planScrollRef.current, -tui.scroll_speed);
      return "handled";
    }
    return "handled";
  }
  if (overlay === "help") {
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return "handled";
    }
    if (name === "escape") {
      closeOverlay();
      return "handled";
    }
    if (name === "down" || name === "j") {
      scrollBoxBy(helpScrollRef.current, 1);
      return "handled";
    }
    if (name === "up" || name === "k") {
      scrollBoxBy(helpScrollRef.current, -1);
      return "handled";
    }
    if (name === "pagedown" || isPageDownKey(key)) {
      scrollBoxBy(helpScrollRef.current, HELP_SCROLL_PAGE);
      return "handled";
    }
    if (name === "pageup" || isPageUpKey(key)) {
      scrollBoxBy(helpScrollRef.current, -HELP_SCROLL_PAGE);
      return "handled";
    }
    return "handled";
  }
  if (overlay === "themes") {
    if (isCommandChord(key, tui)) {
      revertThemePreview();
      openCommandOverlay(ctx);
      return "handled";
    }
    if (name === "escape") {
      revertThemePreview();
      closeOverlay();
      return "handled";
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
      return "handled";
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
      return "handled";
    }
    if (name === "return") {
      const theme = THEME_NAMES[paletteIndex % THEME_NAMES.length];
      if (theme) {
        applyTheme(theme);
      }
    }
    return "handled";
  }
  if (overlay === "env") {
    if (isCommandChord(key, tui)) {
      openCommandOverlay(ctx);
      return "handled";
    }
    if (name === "escape") {
      closeOverlay();
      return "handled";
    }
    if (name === "down" || name === "j") {
      setEnvIndex((i) => Math.min(i + 1, Math.max(0, envOptions.length - 1)));
      return "handled";
    }
    if (name === "up" || name === "k") {
      setEnvIndex((i) => Math.max(0, i - 1));
      return "handled";
    }
    if (name === "return") {
      const option = envOptions[envIndex];
      if (option) {
        applyEnv(option.name);
      }
    }
    return "handled";
  }
  if (overlay === "leader") {
    if (isCommandChord(key, tui)) {
      if (leaderTimer.current) {
        clearTimeout(leaderTimer.current);
      }
      openCommandOverlay(ctx);
      return "handled";
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
    return "handled";
  }
  if (overlay === "config-edit") {
    if (name === "escape") {
      setConfigEditError("");
      closeOverlay();
      return "handled";
    }
    if (hasPrimaryMod(key) && name === "s") {
      saveConfigBuffer();
      return "handled";
    }
    return "pass";
  }
  if (overlayConsumesTyping(overlay)) {
    if (name === "escape") {
      closeOverlay();
      return "handled";
    }
    if (overlay === "slash" && name === "down") {
      setSlashIndex((i) => Math.min(Math.max(filtered.length - 1, 0), i + 1));
      return "handled";
    }
    if (overlay === "slash" && name === "up") {
      setSlashIndex((i) => Math.max(0, i - 1));
      return "handled";
    }
    if (overlay === "slash" && name === "tab") {
      if (key.shift) {
        setSlashIndex((i) => Math.max(0, i - 1));
        return "handled";
      }
      const pick = selectedSlashCommand(filtered, slashIndex);
      if (pick) {
        setQuery(slashCompleteQuery(pick));
      }
      return "handled";
    }
    if (overlay === "slash" && name === "return") {
      submitSlash();
      return "handled";
    }
    return "pass";
  }
  return "handled";
}
