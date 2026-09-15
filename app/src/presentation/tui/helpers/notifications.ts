import type { NotificationAction, UserNotification } from "../../../domain/notifications.ts";
import { clipText } from "./format.ts";

export const NOTICE_CHIP_WIDTH = 9;
export const NOTICE_CHIP_GAP = 1;
export const NOTICE_MARK = "↑";
const MIN_HEADLINE = 12;

export type NoticeChip = {
  action: NotificationAction;
  label: string;
};

export function noticeActionChips(notice: UserNotification): NoticeChip[] {
  const chips: NoticeChip[] = [];
  if (notice.primaryLabel) {
    chips.push({ action: "primary", label: notice.primaryLabel });
  }
  chips.push({ action: "later", label: "Later" }, { action: "dismiss", label: "Dismiss" });
  return chips;
}

export function noticeHeadlineBudget(width: number, actionCount: number): number {
  const actions = actionCount * (NOTICE_CHIP_WIDTH + NOTICE_CHIP_GAP);
  return Math.max(MIN_HEADLINE, width - actions - NOTICE_MARK.length - 3);
}

export function noticeHeadline(notice: UserNotification, width: number): string {
  const chips = noticeActionChips(notice);
  const budget = noticeHeadlineBudget(width, chips.length);
  const full = `${notice.title}  ${notice.body}`;
  if (full.length <= budget) {
    return full;
  }
  if (notice.body.length + 2 <= budget) {
    return notice.body;
  }
  return clipText(notice.body, budget);
}

export function updateChipLabel(latest: string, narrow: boolean): string {
  return narrow ? `${NOTICE_MARK}${latest}` : `${NOTICE_MARK} ${latest}`;
}
