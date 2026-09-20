import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchLogSession, fetchLogStats, fetchLogs } from "../api.ts";
import {
  appendFollowEvents,
  DEFAULT_MAX_MEMORY_EVENTS,
  FACETS_POLL_MS,
  followPollDelay,
  INITIAL_LOG_PAGE_LIMIT,
  logsQueryKey,
  mergeLoadedPage,
  prependOlderPage,
} from "../logs.ts";
import type { LogFacets, LogRow, LogsPayload, LogsQuery } from "../types.ts";

export { DEFAULT_MAX_MEMORY_EVENTS, INITIAL_LOG_PAGE_LIMIT };

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

async function loadLogPage(
  sessionId: string,
  query: LogsQuery,
  extra: Pick<LogsQuery, "cursor" | "direction" | "limit">,
): Promise<LogsPayload> {
  const params: LogsQuery = { ...query, ...extra };
  if (sessionId === "") {
    return fetchLogs(params);
  }
  return fetchLogSession(sessionId, params);
}

export type UseLogSessionOpts = {
  active: boolean;
  paused: boolean;
  query: LogsQuery;
  sessionId?: string;
  maxEvents?: number;
};

export type UseLogSessionResult = {
  events: LogRow[];
  facets: LogFacets | undefined;
  error: string;
  truncated: boolean;
  hasPrev: boolean;
  loading: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  clear: () => void;
  since: string;
};

export function useLogSession(opts: UseLogSessionOpts): UseLogSessionResult {
  const { active, paused, query, sessionId = "", maxEvents = DEFAULT_MAX_MEMORY_EVENTS } = opts;
  const cap = maxEvents > 0 ? maxEvents : DEFAULT_MAX_MEMORY_EVENTS;
  const key = logsQueryKey(query);
  const [events, setEvents] = useState<LogRow[]>([]);
  const [facets, setFacets] = useState<LogFacets | undefined>(undefined);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [since, setSince] = useState("");
  const [epoch, setEpoch] = useState(0);
  const nextCursorRef = useRef("");
  const prevCursorRef = useRef("");
  const queryRef = useRef(query);
  const sinceRef = useRef(since);
  const olderLock = useRef(false);
  const genRef = useRef(0);

  useEffect(() => {
    queryRef.current = query;
  }, [query, key]);
  useEffect(() => {
    sinceRef.current = since;
  }, [since]);

  const applyPageMeta = useCallback((page: LogsPayload, mode: "replace" | "prepend" | "follow") => {
    if (page.next_cursor) {
      nextCursorRef.current = page.next_cursor;
    }
    if (mode !== "follow") {
      prevCursorRef.current = page.prev_cursor ?? "";
      setHasPrev(Boolean(page.prev_cursor) || page.truncated === true);
      setTruncated(page.truncated === true);
    }
  }, []);

  const resetForSessionChange = useCallback(() => {
    nextCursorRef.current = "";
    prevCursorRef.current = "";
    setEvents([]);
    setSince("");
    setHasPrev(false);
    setTruncated(false);
    setEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    const gen = genRef.current + 1;
    genRef.current = gen;
    let cancelled = false;
    nextCursorRef.current = "";
    prevCursorRef.current = "";
    setLoading(true);
    void loadLogPage(sessionId, { ...query, since }, { limit: INITIAL_LOG_PAGE_LIMIT, direction: "forward" })
      .then((page) => {
        if (cancelled || gen !== genRef.current) {
          return;
        }
        if (page.session_changed && sessionId === "") {
          nextCursorRef.current = page.next_cursor ?? "";
        }
        setEvents(mergeLoadedPage([], page.events));
        applyPageMeta(page, "replace");
        if (!page.next_cursor) {
          nextCursorRef.current = "";
        }
        setError("");
      })
      .catch((err: unknown) => {
        if (!cancelled && gen === genRef.current) {
          setError(errorMessage(err, "logs failed"));
        }
      })
      .finally(() => {
        if (!cancelled && gen === genRef.current) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, applyPageMeta, key, query, sessionId, since, epoch]);

  useEffect(() => {
    if (!active || paused || sessionId !== "") {
      return;
    }
    let cancelled = false;
    let timer = 0;
    let idle = false;
    const tick = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      const cursor = nextCursorRef.current;
      if (cursor === "") {
        timer = window.setTimeout(() => {
          void tick();
        }, followPollDelay({ idle: true, hidden: document.hidden }));
        return;
      }
      try {
        const page = await loadLogPage(sessionId, { ...queryRef.current, since: sinceRef.current }, {
          cursor,
          direction: "forward",
        });
        if (cancelled) {
          return;
        }
        if (page.session_changed) {
          setError("Daemon session changed — log history was reset");
          resetForSessionChange();
          idle = true;
        } else {
          const incoming = page.events;
          idle = incoming.length === 0;
          if (incoming.length > 0) {
            setEvents((current) => appendFollowEvents(current, incoming, sinceRef.current, cap));
          }
          applyPageMeta(page, "follow");
          setError("");
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(errorMessage(err, "logs follow failed"));
          idle = true;
        }
      }
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(() => {
        void tick();
      }, followPollDelay({ idle, hidden: document.hidden }));
    };
    timer = window.setTimeout(() => {
      void tick();
    }, followPollDelay({ idle: false, hidden: document.hidden }));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, applyPageMeta, cap, paused, resetForSessionChange, sessionId, key, since]);

  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    const pull = async (): Promise<void> => {
      try {
        const stats = await fetchLogStats({ ...queryRef.current, since: sinceRef.current });
        if (!cancelled) {
          setFacets(stats);
        }
      } catch {
        if (!cancelled) {
          setFacets((current) => current);
        }
      }
    };
    void pull();
    if (paused) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => {
      void pull();
    }, FACETS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, key, paused, since]);

  const loadOlder = useCallback((): void => {
    if (!active || olderLock.current || prevCursorRef.current === "") {
      return;
    }
    olderLock.current = true;
    setLoadingOlder(true);
    const cursor = prevCursorRef.current;
    void loadLogPage(sessionId, { ...queryRef.current, since: sinceRef.current }, {
      cursor,
      direction: "backward",
      limit: INITIAL_LOG_PAGE_LIMIT,
    })
      .then((page) => {
        if (page.session_changed && sessionId === "") {
          setError("Daemon session changed — older log history is no longer available");
          resetForSessionChange();
          return;
        }
        setEvents((current) => prependOlderPage(current, page.events));
        applyPageMeta(page, "prepend");
      })
      .catch((err: unknown) => {
        setError(errorMessage(err, "older logs failed"));
      })
      .finally(() => {
        olderLock.current = false;
        setLoadingOlder(false);
      });
  }, [active, applyPageMeta, resetForSessionChange, sessionId]);

  const clear = useCallback((): void => {
    setEvents([]);
    setSince(new Date().toISOString());
    nextCursorRef.current = "";
    prevCursorRef.current = "";
    setHasPrev(false);
    setTruncated(false);
  }, []);

  return useMemo(
    () => ({
      events,
      facets,
      error,
      truncated,
      hasPrev,
      loading,
      loadingOlder,
      loadOlder,
      clear,
      since,
    }),
    [clear, error, events, facets, hasPrev, loadOlder, loading, loadingOlder, since, truncated],
  );
}
