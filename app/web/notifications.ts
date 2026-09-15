import type { UpdateCheckPayload } from "./types.ts";

export const DISMISSED_NOTIFICATIONS_KEY = "devctl.dismissed-notifications";
export const SESSION_HIDDEN_NOTIFICATIONS_KEY = "devctl.session-hidden-notifications";

export function updateNoticeId(latest: string): string {
  return `update:${latest}`;
}

export function readIdList(storage: Storage, key: string): string[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is string => typeof id === "string" && id !== "");
  } catch {
    return [];
  }
}

export function writeIdList(storage: Storage, key: string, ids: readonly string[]): void {
  try {
    storage.setItem(key, JSON.stringify([...new Set(ids.filter((id) => id !== ""))]));
  } catch {
    // Private mode or quota — keep the in-memory list only.
  }
}

export function isUpdateNoticeVisible(
  check: UpdateCheckPayload,
  dismissed: readonly string[],
  sessionHidden: readonly string[],
): boolean {
  if (!check.newer || check.latest === "") {
    return false;
  }
  const id = updateNoticeId(check.latest);
  return !dismissed.includes(id) && !sessionHidden.includes(id);
}

export function withDismissed(ids: readonly string[], latest: string): string[] {
  return [...new Set([...ids, updateNoticeId(latest)])];
}
