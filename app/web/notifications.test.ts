import { describe, expect, test } from "bun:test";
import {
  isUpdateNoticeVisible,
  readIdList,
  updateNoticeId,
  withDismissed,
  writeIdList,
} from "./notifications.ts";
import type { UpdateCheckPayload } from "./types.ts";

const newer: UpdateCheckPayload = {
  current: "0.9.0",
  latest: "0.10.0",
  newer: true,
  hint: "npm i",
  kind: "npm",
  command: ["npm", "install"],
};

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key) {
      return data.get(key) ?? null;
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key) {
      data.delete(key);
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

describe("web update notice", () => {
  test("is visible only for a newer version that was not dismissed or snoozed", () => {
    expect(isUpdateNoticeVisible(newer, [], [])).toBe(true);
    expect(isUpdateNoticeVisible({ ...newer, newer: false }, [], [])).toBe(false);
    expect(isUpdateNoticeVisible(newer, [updateNoticeId("0.10.0")], [])).toBe(false);
    expect(isUpdateNoticeVisible(newer, [], [updateNoticeId("0.10.0")])).toBe(false);
    expect(isUpdateNoticeVisible(newer, [updateNoticeId("0.9.0")], [])).toBe(true);
  });

  test("dismissing one version does not hide the next", () => {
    expect(withDismissed(["update:0.9.0"], "0.10.0")).toEqual(["update:0.9.0", "update:0.10.0"]);
  });

  test("readIdList and writeIdList round-trip and ignore junk", () => {
    const store = memoryStorage();
    writeIdList(store, "k", ["update:0.10.0", "", "update:0.10.0"]);
    expect(readIdList(store, "k")).toEqual(["update:0.10.0"]);
    store.setItem("k", "{");
    expect(readIdList(store, "k")).toEqual([]);
    store.setItem("k", "[1,\"ok\"]");
    expect(readIdList(store, "k")).toEqual(["ok"]);
    store.setItem("k", "[]");
    expect(readIdList(store, "k")).toEqual([]);
  });
});
