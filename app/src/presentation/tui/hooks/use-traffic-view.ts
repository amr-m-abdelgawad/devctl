import { useCallback, useState } from "react";
import type { Controller } from "../../../application/client-runtime.ts";
import type { TrafficCallPage } from "../../../domain/traffic/traffic.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { toggleTrafficBodyMode, type TrafficBodyMode } from "../helpers/traffic.ts";
import type { Screen } from "../types.ts";
import { useCallDetails, useCallListPolling } from "./use-call-list.ts";

const POLL_MS = 2000;
const PAGE_LIMIT = 200;

const EMPTY_PAGE: TrafficCallPage = { calls: [], nextCursor: "", hasNext: false };

export function useTrafficView(opts: { controller?: Controller; screen: Screen }) {
  const { controller, screen } = opts;
  const [page, setPage] = useState<TrafficCallPage>(EMPTY_PAGE);
  const [error, setError] = useState("");
  // Active caller filter: "" = all, "-" = hops with no caller, else a service.
  const [caller, setCaller] = useState("");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [bodyMode, setBodyMode] = useState<TrafficBodyMode>("json");
  const toggleBodyMode = useCallback(() => {
    setBodyMode(toggleTrafficBodyMode);
  }, []);
  const details = useCallDetails(page, controller ? (id) => controller.getTrafficCall(id) : undefined);

  const refresh = useCallback(async () => {
    if (!controller) {
      return;
    }
    try {
      const needle = search.trim();
      const next = await controller.trafficCallsPage({
        limit: PAGE_LIMIT,
        caller: caller === "" ? undefined : caller,
        search: needle === "" ? undefined : needle,
        summary: true,
      });
      setPage({
        calls: next?.calls ?? [],
        nextCursor: next?.nextCursor ?? "",
        hasNext: next?.hasNext === true,
      });
      setError("");
    } catch (err) {
      setError(humanMessage(err));
    }
  }, [controller, caller, search]);

  useCallListPolling(screen === "proxy" && controller !== undefined, refresh, POLL_MS);

  return {
    ...details,
    error,
    refresh,
    caller,
    setCaller,
    search,
    setSearch,
    searchFocused,
    setSearchFocused,
    bodyMode,
    toggleBodyMode,
  };
}
