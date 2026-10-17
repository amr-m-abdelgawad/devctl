import { useCallback, useState } from "react";
import type { Controller } from "../../../application/client-runtime.ts";
import type { LlmCallPage } from "../../../domain/llm/llm.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { toggleLlmBodyMode, type LlmBodyMode } from "../helpers/llm.ts";
import type { Screen } from "../types.ts";
import { useCallDetails, useCallListPolling } from "./use-call-list.ts";

const POLL_MS = 2000;
const PAGE_LIMIT = 200;

const EMPTY_PAGE: LlmCallPage = { calls: [], nextCursor: "", hasNext: false, errors: [] };

export function useLlmView(opts: { controller?: Controller; screen: Screen }) {
  const { controller, screen } = opts;
  const [page, setPage] = useState<LlmCallPage>(EMPTY_PAGE);
  const [error, setError] = useState("");
  // Active caller filter: "" = all, "-" = calls with no caller, else a service.
  const [caller, setCaller] = useState("");
  const [bodyMode, setBodyMode] = useState<LlmBodyMode>("conversation");
  const toggleBodyMode = useCallback(() => {
    setBodyMode(toggleLlmBodyMode);
  }, []);
  const details = useCallDetails(page, controller ? (id) => controller.getLlmCall(id) : undefined);

  const refresh = useCallback(async () => {
    if (!controller) {
      return;
    }
    try {
      const next = await controller.llmCallsPage({ limit: PAGE_LIMIT, caller: caller === "" ? undefined : caller, summary: true });
      setPage({
        calls: next?.calls ?? [],
        nextCursor: next?.nextCursor ?? "",
        hasNext: next?.hasNext === true,
        errors: next?.errors ?? [],
      });
      setError("");
    } catch (err) {
      setError(humanMessage(err));
    }
  }, [controller, caller]);

  useCallListPolling(screen === "llm" && controller !== undefined, refresh, POLL_MS);

  return {
    ...details,
    error,
    refresh,
    caller,
    setCaller,
    bodyMode,
    toggleBodyMode,
  };
}
