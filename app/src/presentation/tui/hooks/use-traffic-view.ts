import { useCallback, useEffect, useState } from "react";
import type { Controller } from "../../../application/client-runtime.ts";
import type { TrafficCall, TrafficCallPage } from "../../../domain/traffic/traffic.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { toggleTrafficBodyMode, type TrafficBodyMode } from "../helpers/traffic.ts";
import type { Screen } from "../types.ts";
import { useCallListSelection } from "./use-call-list.ts";

const POLL_MS = 2000;
const PAGE_LIMIT = 200;

const EMPTY_PAGE: TrafficCallPage = { calls: [], nextCursor: "", hasNext: false };

export function useTrafficView(opts: { controller?: Controller; screen: Screen }) {
  const { controller, screen } = opts;
  const [page, setPage] = useState<TrafficCallPage>(EMPTY_PAGE);
  const [detail, setDetail] = useState<TrafficCall | undefined>(undefined);
  const [error, setError] = useState("");
  const [bodyMode, setBodyMode] = useState<TrafficBodyMode>("json");
  const toggleBodyMode = useCallback(() => {
    setBodyMode(toggleTrafficBodyMode);
  }, []);
  const selection = useCallListSelection(page.calls);

  const refresh = useCallback(async () => {
    if (!controller) {
      return;
    }
    try {
      const next = await controller.trafficCallsPage({ limit: PAGE_LIMIT });
      setPage({
        calls: next?.calls ?? [],
        nextCursor: next?.nextCursor ?? "",
        hasNext: next?.hasNext === true,
      });
      setError("");
    } catch (err) {
      setError(humanMessage(err));
    }
  }, [controller]);

  useEffect(() => {
    if (screen !== "proxy" || !controller) {
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [screen, controller, refresh]);

  useEffect(() => {
    if (!detail?.id) {
      return;
    }
    const next = page.calls.find((call) => call.id === detail.id);
    if (next) {
      setDetail(next);
    }
  }, [page.calls, detail?.id]);

  return {
    page,
    detail,
    setDetail,
    error,
    refresh,
    bodyMode,
    toggleBodyMode,
    selectedIndex: selection.selectedIndex,
    pick: selection.pick,
    move: selection.move,
  };
}
