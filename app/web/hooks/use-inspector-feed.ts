import { useCallback, useEffect, useRef, useState } from "react";

type CallPage = { calls: Array<{ id: string }>; has_more?: boolean; next_cursor?: string };

/** Live head pages and explicitly paused history share a single filter generation. */
export function useInspectorFeed<P extends CallPage>(
  active: boolean,
  fetchPage: (params: Record<string, string>) => Promise<P>,
  params: Record<string, string>,
) {
  const [payload, setPayload] = useState<P>();
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const pausedRef = useRef(false);
  const moreLock = useRef(false);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!active) {
      setPayload(undefined);
      return;
    }
    const gen = ++generation.current;
    setPayload(undefined);
    setError("");
    setLoadingMore(false);
    moreLock.current = false;
    void fetchPage(paramsRef.current)
      .then((next) => {
        if (generation.current === gen) setPayload(next);
      })
      .catch((err: unknown) => {
        if (generation.current === gen) setError(err instanceof Error ? err.message : "Unable to load calls");
      });
    return () => {
      generation.current += 1;
    };
  }, [active, fetchPage, key, revision]);
  useEffect(() => {
    if (!active || paused) return;
    const gen = generation.current;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      void fetchPage(paramsRef.current)
        .then((next) => {
          if (generation.current === gen && !pausedRef.current) {
            setPayload(next);
            setError("");
          }
        })
        .catch((err: unknown) => {
          if (generation.current === gen) setError(err instanceof Error ? err.message : "Unable to refresh calls");
        })
        .finally(() => {
          inFlight = false;
        });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [active, fetchPage, key, paused, revision]);
  const loadMore = useCallback(() => {
    if (!payload?.has_more || !payload.next_cursor || moreLock.current) return;
    moreLock.current = true;
    setLoadingMore(true);
    pausedRef.current = true;
    setPaused(true);
    const gen = generation.current;
    void fetchPage({ ...paramsRef.current, cursor: payload.next_cursor })
      .then((next) => {
        if (gen !== generation.current) return;
        setPayload((current) => {
          if (!current) return next;
          const ids = new Set(current.calls.map((call) => call.id));
          return { ...next, calls: [...current.calls, ...next.calls.filter((call) => !ids.has(call.id))] } as P;
        });
        setError("");
      })
      .catch((err: unknown) => {
        if (gen === generation.current) setError(err instanceof Error ? err.message : "Unable to load older calls");
      })
      .finally(() => {
        if (gen === generation.current) {
          moreLock.current = false;
          setLoadingMore(false);
        }
      });
  }, [fetchPage, payload]);
  const togglePause = (): void => {
    pausedRef.current = !paused;
    setPaused(!paused);
    if (paused) setRevision((value) => value + 1);
  };
  return { payload, error, paused, loadingMore, loadMore, togglePause };
}
