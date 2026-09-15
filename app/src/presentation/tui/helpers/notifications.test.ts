import { describe, expect, test } from "bun:test";
import type { UserNotification } from "../../../domain/notifications.ts";
import { noticeActionChips, noticeHeadline, updateChipLabel } from "./notifications.ts";

const notice: UserNotification = {
  id: "update:0.10.0",
  kind: "update",
  title: "New version available",
  body: "0.9.0 → 0.10.0",
  hint: "Install with /update.",
  severity: "info",
  primaryLabel: "Update",
};

describe("notice bar copy", () => {
  test("installable notices get Update, Later, and Dismiss chips", () => {
    expect(noticeActionChips(notice).map((chip) => chip.label)).toEqual(["Update", "Later", "Dismiss"]);
    expect(noticeActionChips({ ...notice, primaryLabel: undefined }).map((chip) => chip.action)).toEqual([
      "later",
      "dismiss",
    ]);
  });

  test("wide terminals keep the title; narrow ones keep the version range", () => {
    expect(noticeHeadline(notice, 80)).toBe("New version available  0.9.0 → 0.10.0");
    expect(noticeHeadline(notice, 56)).toBe("0.9.0 → 0.10.0");
    expect(noticeHeadline(notice, 18).startsWith("0.9.0")).toBe(true);
  });

  test("header chip shortens on a stacked header", () => {
    expect(updateChipLabel("0.10.0", false)).toBe("↑ 0.10.0");
    expect(updateChipLabel("0.10.0", true)).toBe("↑0.10.0");
  });
});
