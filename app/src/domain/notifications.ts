import type { UpdateCheck } from "./update.ts";

export const NOTIFICATION_KINDS = ["update"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationAction = "primary" | "later" | "dismiss";

export type UserNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  hint: string;
  severity: "info" | "warning";
  primaryLabel?: string;
};

/** A stored reaction to a notification id. Forever-dismiss has no `snoozeUntil`. */
export type NotificationReceipt = {
  id: string;
  snoozeUntil?: number;
};

export function notificationId(kind: NotificationKind, subject: string): string {
  return `${kind}:${subject}`;
}

export function isNotificationVisible(
  id: string,
  receipts: readonly NotificationReceipt[],
  nowMs: number,
): boolean {
  const receipt = receipts.find((row) => row.id === id);
  if (!receipt) {
    return true;
  }
  if (receipt.snoozeUntil === undefined) {
    return false;
  }
  return nowMs >= receipt.snoozeUntil;
}

export function dismissNotification(
  id: string,
  receipts: readonly NotificationReceipt[],
): NotificationReceipt[] {
  return upsertReceipt(receipts, { id });
}

export function snoozeNotification(
  id: string,
  untilMs: number,
  receipts: readonly NotificationReceipt[],
): NotificationReceipt[] {
  return upsertReceipt(receipts, { id, snoozeUntil: untilMs });
}

export function dismissedIds(receipts: readonly NotificationReceipt[]): string[] {
  return receipts.filter((row) => row.snoozeUntil === undefined).map((row) => row.id);
}

export function receiptsFromDismissedIds(ids: readonly string[]): NotificationReceipt[] {
  return [...new Set(ids.filter((id) => id !== ""))].map((id) => ({ id }));
}

/**
 * Operator-facing notice when GitHub Releases has a newer tag than this process.
 * Id is keyed by the latest version so dismissing 0.10.0 does not hide 0.11.0.
 */
export function updateAvailableNotice(check: UpdateCheck): UserNotification | undefined {
  if (!check.newer || check.latest === "") {
    return undefined;
  }
  const canInstall = (check.command?.length ?? 0) > 0;
  return {
    id: notificationId("update", check.latest),
    kind: "update",
    title: "New version available",
    body: `${check.current} → ${check.latest}`,
    hint: canInstall
      ? "Install with /update. Later hides this until the next session."
      : check.hint,
    severity: "info",
    primaryLabel: canInstall ? "Update" : undefined,
  };
}

function upsertReceipt(
  receipts: readonly NotificationReceipt[],
  next: NotificationReceipt,
): NotificationReceipt[] {
  const rest = receipts.filter((row) => row.id !== next.id);
  return [...rest, next];
}
