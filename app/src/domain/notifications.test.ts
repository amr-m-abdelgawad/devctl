import { describe, expect, test } from "bun:test";
import {
  dismissNotification,
  dismissedIds,
  isNotificationVisible,
  notificationId,
  receiptsFromDismissedIds,
  snoozeNotification,
  updateAvailableNotice,
} from "./notifications.ts";
import type { UpdateCheck } from "./update.ts";

const NOW = 1_700_000_000_000;

function check(over: Partial<UpdateCheck> = {}): UpdateCheck {
  return {
    current: "0.9.0",
    latest: "0.10.0",
    newer: true,
    hint: "npm i",
    kind: "npm",
    command: ["npm", "install", "--global", "devctl@latest"],
    ...over,
  };
}

describe("notifications", () => {
  test("updateAvailableNotice is keyed by the latest version and offers install", () => {
    const notice = updateAvailableNotice(check());
    expect(notice).toEqual({
      id: "update:0.10.0",
      kind: "update",
      title: "New version available",
      body: "0.9.0 → 0.10.0",
      hint: "Install with /update. Later hides this until the next session.",
      severity: "info",
      primaryLabel: "Update",
    });
    expect(notificationId("update", "0.11.0")).toBe("update:0.11.0");
  });

  test("updateAvailableNotice is absent when current is newest or latest is unknown", () => {
    expect(updateAvailableNotice(check({ newer: false }))).toBeUndefined();
    expect(updateAvailableNotice(check({ latest: "", newer: false }))).toBeUndefined();
  });

  test("without an install command the notice still shows, with the channel hint", () => {
    const notice = updateAvailableNotice(check({ command: undefined, hint: "git pull && bun install", kind: "source" }));
    expect(notice?.primaryLabel).toBeUndefined();
    expect(notice?.hint).toBe("git pull && bun install");
  });

  test("dismiss hides that id forever; a newer subject stays visible", () => {
    const receipts = dismissNotification("update:0.10.0", []);
    expect(isNotificationVisible("update:0.10.0", receipts, NOW)).toBe(false);
    expect(isNotificationVisible("update:0.11.0", receipts, NOW)).toBe(true);
    expect(dismissedIds(receipts)).toEqual(["update:0.10.0"]);
  });

  test("snooze hides until the timestamp, then returns", () => {
    const receipts = snoozeNotification("update:0.10.0", NOW + 1, []);
    expect(isNotificationVisible("update:0.10.0", receipts, NOW)).toBe(false);
    expect(isNotificationVisible("update:0.10.0", receipts, NOW + 1)).toBe(true);
  });

  test("receipts round-trip from persisted dismissed ids and ignore blanks", () => {
    const receipts = receiptsFromDismissedIds(["update:0.10.0", "", "update:0.10.0"]);
    expect(receipts).toEqual([{ id: "update:0.10.0" }]);
    expect(dismissedIds(receipts)).toEqual(["update:0.10.0"]);
  });
});
