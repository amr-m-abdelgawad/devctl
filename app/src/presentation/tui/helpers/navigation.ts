import { type NavItem, type Screen } from "../types.ts";
import { clipText } from "./format.ts";

export const SETUP_STEP_COUNT = 9;

export const TAB_CHIP_PAD = 2;

export const TAB_OVERFLOW_MARK_WIDTH = 2;

const COMPACT_NAV_WIDTH = 80;

const VERY_COMPACT_NAV_WIDTH = 56;

export function tabChipWidth(label: string): number {
  return label.length + TAB_CHIP_PAD;
}

export function navTabLabel(label: string, width: number): string {
  if (width < VERY_COMPACT_NAV_WIDTH) {
    return clipText(label, 3);
  }
  if (width < COMPACT_NAV_WIDTH) {
    return clipText(label, 4);
  }
  return label;
}

export type TabRange = {
  start: number;
  end: number;
};

export function visibleTabRange(widths: number[], activeIndex: number, budget: number): TabRange {
  const count = widths.length;
  if (count === 0 || budget <= 0) {
    return { start: 0, end: -1 };
  }
  const focus = activeIndex >= 0 && activeIndex < count ? activeIndex : 0;
  const unconstrained = growTabRange(widths, focus, budget);
  if (unconstrained.start === 0 && unconstrained.end === count - 1) {
    return unconstrained;
  }
  const leftMark = focus > 0 ? TAB_OVERFLOW_MARK_WIDTH : 0;
  const rightMark = focus < count - 1 ? TAB_OVERFLOW_MARK_WIDTH : 0;
  const reserved = leftMark + rightMark;
  const range = growTabRange(widths, focus, Math.max(widths[focus] ?? 0, budget - reserved));
  const reclaim =
    (leftMark > 0 && range.start === 0 ? TAB_OVERFLOW_MARK_WIDTH : 0) +
    (rightMark > 0 && range.end === count - 1 ? TAB_OVERFLOW_MARK_WIDTH : 0);
  if (reclaim === 0) {
    return range;
  }
  return growTabRange(widths, focus, Math.max(widths[focus] ?? 0, budget - reserved + reclaim));
}

function growTabRange(widths: number[], focus: number, budget: number): TabRange {
  const count = widths.length;
  let start = focus;
  let end = focus;
  let used = widths[focus] ?? 0;
  if (used >= budget) {
    return { start: focus, end: focus };
  }
  while (start > 0 || end < count - 1) {
    const addLeft = start > 0 ? (widths[start - 1] ?? 0) : Number.POSITIVE_INFINITY;
    const addRight = end < count - 1 ? (widths[end + 1] ?? 0) : Number.POSITIVE_INFINITY;
    const leftFits = start > 0 && used + addLeft <= budget;
    const rightFits = end < count - 1 && used + addRight <= budget;
    if (!leftFits && !rightFits) {
      break;
    }
    const leftDistance = focus - (start - 1);
    const rightDistance = end + 1 - focus;
    if (leftFits && (!rightFits || leftDistance <= rightDistance)) {
      start -= 1;
      used += addLeft;
    } else if (rightFits) {
      end += 1;
      used += addRight;
    } else {
      break;
    }
  }
  return { start, end };
}

export function navActiveIndex(screen: Screen): number {
  if (screen === "detail") {
    return NAV_ITEMS.findIndex((item) => item.id === "services");
  }
  return NAV_ITEMS.findIndex((item) => item.id === screen);
}

// No fallback constant here on purpose: the mcp screen's row count now
// depends on how many tools exist, which only screens/Mcp.tsx knows. A
// hardcoded duplicate would silently go stale the next time a tool is added.

export function screenListCount(
  screen: Screen,
  counts: { doctor: number; settings: number; profiles: number; services: number; logs?: number; mcp?: number },
): number {
  if (screen === "doctor") {
    return counts.doctor;
  }
  if (screen === "settings") {
    return counts.settings;
  }
  if (screen === "profiles") {
    return counts.profiles;
  }
  if (screen === "dashboard" || screen === "services") {
    return counts.services;
  }
  if (screen === "logs") {
    return counts.logs ?? 0;
  }
  if (screen === "mcp") {
    return counts.mcp ?? 0;
  }
  if (screen === "setup") {
    return SETUP_STEP_COUNT;
  }
  return 0;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "dashboard" },
  { id: "services", label: "services" },
  { id: "logs", label: "logs" },
  { id: "auth", label: "identity" },
  { id: "credentials", label: "credentials" },
  { id: "proxy", label: "proxy" },
  { id: "doctor", label: "doctor" },
  { id: "config", label: "config" },
  { id: "profiles", label: "profiles" },
  { id: "setup", label: "setup" },
  { id: "stats", label: "stats" },
  { id: "settings", label: "settings" },
];

export function navItemForDigit(name: string): Screen | undefined {
  if (name === "0") {
    return NAV_ITEMS[9]?.id;
  }
  if (name.length === 1 && name >= "1" && name <= "9") {
    return NAV_ITEMS[Number(name) - 1]?.id;
  }
  return undefined;
}

export const NAV_CYCLE: Screen[] = NAV_ITEMS.map((item) => item.id);
