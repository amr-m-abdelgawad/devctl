import { type BusEvent } from "../../../shared/events.ts";
import { type ConfirmDetail, type ConfirmKind, type FooterHint } from "../types.ts";
import { clipText } from "./format.ts";
import { runningLabel } from "./logs.ts";
import { tabChipWidth } from "./navigation.ts";

export const NARROW_WIDTH = 100;

export const HEADER_STACK_WIDTH = 90;

export const HEADER_NARROW_WIDTH = 60;

export const PAGE_SCROLL_MIN = 8;

export const PLAN_OVERLAY_MAX = 22;

export const PLAN_OVERLAY_CHROME = 6;

export const COMPACT_CHROME_HEIGHT = 20;

const CHROME_HEADER = 1;

const CHROME_NAV = 1;

const CHROME_STATUS = 1;

const CHROME_RULE = 1;

export function chromeReserved(termW: number, toolbarRules = true): number {
  const headerRows = termW < HEADER_STACK_WIDTH ? CHROME_HEADER + 1 : CHROME_HEADER;
  const rule = toolbarRules ? CHROME_RULE : 0;
  return headerRows + rule + CHROME_NAV + rule + CHROME_STATUS + rule;
}

export const CHROME_RESERVED = chromeReserved(HEADER_STACK_WIDTH - 1);

export function pageScrollAmount(termH: number): number {
  return Math.max(PAGE_SCROLL_MIN, termH - PLAN_OVERLAY_CHROME * 2);
}

export function planOverlayHeight(termH: number, contentRows: number): number {
  const cap = Math.min(PLAN_OVERLAY_MAX, Math.max(PAGE_SCROLL_MIN, termH - PLAN_OVERLAY_CHROME));
  return Math.min(cap, Math.max(PAGE_SCROLL_MIN, contentRows));
}

export type HeaderChip = { label: string; tone: "success" | "idle" | "info" | "error" | "warning"; hide?: boolean };

export function headerStatusChips(opts: {
  width: number;
  running: number;
  total: number;
  proxyOn: boolean;
  proxyAddress: string;
  mcpOn: boolean;
  adc: boolean;
  reveal: boolean;
}): HeaderChip[] {
  const narrow = opts.width < HEADER_NARROW_WIDTH;
  const proxyLabel = opts.proxyOn ? `● ${clipText(opts.proxyAddress, narrow ? 10 : 18)}` : "";
  return [
    { label: narrow ? `${opts.running}/${opts.total}` : runningLabel(opts.running, opts.total), tone: opts.running > 0 ? "success" : "idle" },
    { label: proxyLabel, tone: "info", hide: !opts.proxyOn },
    { label: "MCP", tone: "info", hide: !opts.mcpOn },
    { label: opts.adc ? (narrow ? "ADC" : "ADC ok") : narrow ? "!ADC" : "ADC missing", tone: opts.adc ? "success" : "error" },
    { label: narrow ? "sec" : "secrets shown", tone: "warning", hide: !opts.reveal },
  ];
}

export function visibleHints(hints: FooterHint[], width: number): FooterHint[] {
  const out: FooterHint[] = [];
  let used = 0;
  for (const hint of hints) {
    const cost = hint.key.length + hint.label.length + 3;
    if (used + cost > width) {
      break;
    }
    out.push(hint);
    used += cost;
  }
  return out;
}

export type OverlayRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function compactChrome(termH: number): boolean {
  return termH < COMPACT_CHROME_HEIGHT;
}

export function overlayRect(
  termW: number,
  termH: number,
  preferW: number,
  preferH: number,
  anchor: "center" | "bottom" = "center",
  toolbarRules = true,
): OverlayRect {
  const width = Math.min(preferW, Math.max(1, termW - 4));
  const chrome = Math.min(chromeReserved(termW, toolbarRules), Math.max(0, termH - 1));
  const height = Math.min(preferH, Math.max(1, termH - chrome));
  const left = Math.max(0, Math.min(Math.floor((termW - width) / 2), Math.max(0, termW - width)));
  const rawTop = anchor === "bottom" ? termH - 2 - height : Math.floor((termH - height) / 2);
  const top = Math.max(0, Math.min(rawTop, termH - height));
  return { left, top, width, height };
}

export type StatusTone = "success" | "warning" | "error" | "info" | "idle";

const SUCCESS_STATUS = /^(started|stopped|restarted|refreshed|cleared|copied|exported|jumped|proxy started|proxy stopped|secrets|re-running|theme |mouse |leader |display |restored)/i;

const ERROR_STATUS = /\b(fail|error|unknown|not found|no configuration|blocked|already in use|is using port)\b/i;

export function statusChipTone(status: string): StatusTone {
  if (status === "") {
    return "idle";
  }
  if (ERROR_STATUS.test(status)) {
    return "error";
  }
  if (status.includes("session only")) {
    return "warning";
  }
  if (SUCCESS_STATUS.test(status)) {
    return "success";
  }
  return "info";
}

export function confirmCopy(kind: ConfirmKind, profile: string, detail?: ConfirmDetail): { title: string; body: string } {
  if (kind === "quit") {
    return {
      title: "Quit",
      body: "Stop managed services and leave the TUI? Press d to detach and leave them running.",
    };
  }
  if (kind === "reload") {
    return {
      title: "Reload applied",
      body: profile === "" ? "Configuration changed. Restart marked services?" : `Restart required: ${profile}`,
    };
  }
  if (kind === "reset-prefs") {
    return {
      title: "Reset preferences",
      body: "Restore theme, display size, mouse, and leader timeout to defaults? This overwrites your saved tui.json values.",
    };
  }
  if (kind === "free-port") {
    const port = detail?.port ?? 0;
    const proc = detail?.process || "process";
    const pid = detail?.pid ?? 0;
    return {
      title: `Free port ${port}`,
      body: `Stop ${proc} (pid ${pid}) so port ${port} can be used? This sends SIGTERM, then SIGKILL if it stays up.`,
    };
  }
  return {
    title: "Start profile",
    body: profile === "" ? "Start the configured services?" : `Start profile ${profile}?`,
  };
}

export type StatusStripChip = {
  label: string;
  tone: "idle" | "muted" | "primary" | "accent" | "info" | "success" | "warning" | "error";
};

export function statusStripChips(
  email: string | undefined,
  project: string | undefined,
  logsTotal: number,
  paneWidth: number,
): StatusStripChip[] {
  const budget = Math.max(8, paneWidth - 2);
  const logsText = `logs ${logsTotal}`;
  const logsCost = tabChipWidth(logsText);
  const user = email || "(no user)";
  const rawProject = project || "";

  if (budget <= logsCost + 6) {
    const userBudget = Math.max(2, budget - logsCost - 2);
    return [
      { label: clipText(user, userBudget), tone: "idle" },
      { label: clipText(logsText, logsCost - 2), tone: "muted" },
    ];
  }

  const remaining = budget - logsCost;

  if (rawProject && remaining >= 36) {
    const projLabel = clipText(rawProject, 14);
    const projCost = tabChipWidth(projLabel);
    const userBudget = remaining - projCost - 2;
    const userPrefix = userBudget >= user.length + 9 ? `identity ${user}` : user;
    const userLabel = clipText(userPrefix, userBudget);
    return [
      { label: userLabel, tone: "idle" },
      { label: projLabel, tone: "muted" },
      { label: logsText, tone: "muted" },
    ];
  }

  if (rawProject && remaining >= 28 && rawProject.length <= 10) {
    const projLabel = clipText(rawProject, 10);
    const projCost = tabChipWidth(projLabel);
    const userBudget = remaining - projCost - 2;
    return [
      { label: clipText(user, userBudget), tone: "idle" },
      { label: projLabel, tone: "muted" },
      { label: logsText, tone: "muted" },
    ];
  }

  const userPrefix = remaining >= user.length + 9 ? `identity ${user}` : user;
  const userLabel = clipText(userPrefix, remaining - 2);
  return [
    { label: userLabel, tone: "idle" },
    { label: logsText, tone: "muted" },
  ];
}

// The message a ConfigurationReloadFailed event's persistent banner shows.
// Falls back for a missing or malformed payload rather than rendering
// "undefined" — an ordinary bus event still guarantees a type, not a
// well-formed payload.
export function reloadFailureMessage(ev: BusEvent): string {
  const message = ev.payload?.error;
  return typeof message === "string" && message !== "" ? message : "configuration reload failed";
}
