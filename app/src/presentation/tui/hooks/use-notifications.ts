import { useCallback, useEffect, useMemo, useState } from "react";
import {
  dismissedIds,
  isNotificationVisible,
  receiptsFromDismissedIds,
  snoozeNotification,
  updateAvailableNotice,
  type UserNotification,
} from "../../../domain/notifications.ts";
import type { UpdateCheck } from "../../../domain/update.ts";
import type { TuiPreferencePatch } from "../tui-config.ts";

type Options = {
  checkUpdate: () => Promise<UpdateCheck>;
  dismissed: readonly string[];
  prefsLocked: boolean;
  saveTuiPreferences: (partial: TuiPreferencePatch) => string;
  setStatus: (message: string) => void;
};

export function useNotifications({
  checkUpdate,
  dismissed,
  prefsLocked,
  saveTuiPreferences,
  setStatus,
}: Options) {
  const [check, setCheck] = useState<UpdateCheck | undefined>();
  const [receipts, setReceipts] = useState(() => receiptsFromDismissedIds(dismissed));

  useEffect(() => {
    let cancelled = false;
    void checkUpdate()
      .then((result) => {
        if (!cancelled) {
          setCheck(result);
        }
      })
      .catch(() => {
        // A failed GitHub probe must not interrupt the TUI.
      });
    return () => {
      cancelled = true;
    };
  }, [checkUpdate]);

  const notice = useMemo((): UserNotification | undefined => {
    if (!check) {
      return undefined;
    }
    const next = updateAvailableNotice(check);
    if (!next || !isNotificationVisible(next.id, receipts, Date.now())) {
      return undefined;
    }
    return next;
  }, [check, receipts]);

  const persistDismissed = useCallback(
    (nextReceipts: ReturnType<typeof receiptsFromDismissedIds>) => {
      setReceipts(nextReceipts);
      if (prefsLocked) {
        return;
      }
      saveTuiPreferences({ dismissed_notifications: dismissedIds(nextReceipts) });
    },
    [prefsLocked, saveTuiPreferences],
  );

  const later = useCallback(() => {
    if (!notice) {
      setStatus("no notices");
      return;
    }
    setReceipts((current) => snoozeNotification(notice.id, Number.MAX_SAFE_INTEGER, current));
    setStatus("Hidden until next session");
  }, [notice, setStatus]);

  const dismiss = useCallback(() => {
    if (!notice) {
      setStatus("no notices");
      return;
    }
    persistDismissed(receiptsFromDismissedIds([...dismissedIds(receipts), notice.id]));
    const version = check?.latest ?? "this version";
    setStatus(prefsLocked ? `Won't remind you about ${version}  session only` : `Won't remind you about ${version}`);
  }, [check?.latest, notice, persistDismissed, prefsLocked, receipts, setStatus]);

  const hideCurrent = useCallback(() => {
    if (!notice) {
      return;
    }
    setReceipts((current) => snoozeNotification(notice.id, Number.MAX_SAFE_INTEGER, current));
  }, [notice]);

  return { notice, check, applyCheck: setCheck, later, dismiss, hideCurrent };
}
