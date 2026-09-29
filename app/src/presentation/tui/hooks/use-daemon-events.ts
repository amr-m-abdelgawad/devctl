import { useEffect } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import type { LogEvent } from "../../../domain/logs/logs.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { ConfigurationChanged, ConfigurationReloadFailed, LogBatch, LogReceived, type BusEvent } from "../../../shared/events.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { reloadFailureMessage } from "../helpers/chrome.ts";
import { appendVisibleLogs, trimLogBytes } from "../helpers/logs.ts";
import { LogGapTracker, mergeGapPage } from "../helpers/log-gaps.ts";
import { encodeLogCursor } from "../../../domain/logs/logs.ts";

import type { Dispatch, SetStateAction } from "react";

// A gap is paged in only after the stream has opened no new gap for this long.
const GAP_CALM_MS = 500;
// Pause between gap pages so filling never competes with the live stream.
const GAP_FILL_PACE_MS = 100;
// Pages per calm period (10,000 records). Each page is a daemon query, so a
// long flood fills only its most recent part.
const GAP_FILL_MAX_PAGES = 20;

type Options = {
  controller?: Controller;
  cfg?: DevctlConfig;
  paused: boolean;
  logSince: string;
  refresh: () => Promise<StatusSnapshot | undefined>;
  setLogs: Dispatch<SetStateAction<LogEvent[]>>;
  setCfg: Dispatch<SetStateAction<DevctlConfig | undefined>>;
  setConfigReloadError: (error: string | undefined) => void;
  setStatus: (status: string) => void;
};

export function useDaemonEvents({
  controller,
  cfg,
  paused,
  logSince,
  refresh,
  setLogs,
  setCfg,
  setConfigReloadError,
  setStatus,
}: Options) {
  useEffect(() => {
    if (!controller) {
      return;
    }
    let logTimer: ReturnType<typeof setTimeout> | undefined;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    let statusDirty = false;
    const pendingLogs: LogEvent[] = [];
    const cap = cfg && cfg.logs.max_memory_events > 0 ? cfg.logs.max_memory_events : 50_000;
    // During a flood the daemon sends only the newest records of each batch.
    // Once the stream is calm, the skipped ranges are paged in, newest first,
    // for as far back as the view still reaches.
    const gaps = new LogGapTracker(cap);
    let session = "";
    let oldestHeld: number | undefined;
    let lastGapAt = 0;
    let pagesLeft = GAP_FILL_MAX_PAGES;
    let filling = false;
    let fillTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const noteHeld = (rows: LogEvent[]): LogEvent[] => {
      oldestHeld = rows.find((row) => row.seq > 0)?.seq;
      return rows;
    };
    const scheduleFill = (delayMs: number): void => {
      if (fillTimer === undefined && !disposed) {
        fillTimer = setTimeout(() => {
          fillTimer = undefined;
          fillGaps();
        }, delayMs);
      }
    };
    const fillGaps = (): void => {
      if (disposed || filling || session === "" || !gaps.pending || pagesLeft <= 0) {
        return;
      }
      const calmFor = Date.now() - lastGapAt;
      if (calmFor < GAP_CALM_MS) {
        scheduleFill(GAP_CALM_MS - calmFor);
        return;
      }
      const range = gaps.next(oldestHeld);
      if (range === undefined) {
        return;
      }
      filling = true;
      pagesLeft -= 1;
      const wanted = range.to - range.from + 1;
      const cursor = encodeLogCursor({ session, seq: range.to + 1 });
      controller.logsPage({ cursor, direction: "backward", limit: wanted }).then((page) => {
        filling = false;
        if (disposed) {
          return;
        }
        if (page.sessionChanged) {
          gaps.clear();
          return;
        }
        gaps.remove(range);
        const found = page.events.filter((event) => event.seq >= range.from && event.seq <= range.to);
        setLogs((current) => noteHeld(trimLogBytes(mergeGapPage(current, found, logSince, cap))));
        // A short page means the daemon no longer holds that range; older gaps are older still.
        if (found.length < wanted) {
          gaps.clear();
          return;
        }
        scheduleFill(GAP_FILL_PACE_MS);
      }, () => {
        filling = false;
      });
    };
    const flushLogs = (): void => {
      logTimer = undefined;
      if (pendingLogs.length > 0) {
        const batch = pendingLogs.splice(0, pendingLogs.length);
        if (gaps.observe(batch)) {
          lastGapAt = Date.now();
          pagesLeft = GAP_FILL_MAX_PAGES;
        }
        setLogs((current) => noteHeld(trimLogBytes(appendVisibleLogs(current, batch, logSince, cap))));
        fillGaps();
      }
    };
    const flushStatus = (): void => {
      statusTimer = undefined;
      if (statusDirty) {
        statusDirty = false;
        void refresh();
      }
    };
    const scheduleLogs = (): void => {
      if (!logTimer) {
        logTimer = setTimeout(flushLogs, 50);
      }
    };
    const scheduleStatus = (): void => {
      if (!statusTimer) {
        statusTimer = setTimeout(flushStatus, 2_000);
      }
    };
    const unsub = controller.onEvent((ev: BusEvent) => {
      if (ev.type === LogBatch && ev.payload && typeof ev.payload === "object" && "newest" in ev.payload) {
        const payload = ev.payload as { newest?: LogEvent[]; session?: unknown };
        const newest = payload.newest ?? [];
        if (typeof payload.session === "string") {
          session = payload.session;
        }
        if (!paused) {
          pendingLogs.push(...newest);
        }
        scheduleLogs();
        return;
      }
      if (ev.type === LogReceived && ev.payload && typeof ev.payload === "object" && "event" in ev.payload) {
        const incoming = ev.payload.event as LogEvent;
        if (!paused) {
          pendingLogs.push(incoming);
        }
        scheduleLogs();
        return;
      }
      if (ev.type === ConfigurationReloadFailed) {
        setConfigReloadError(reloadFailureMessage(ev));
        return;
      }
      if (ev.type === ConfigurationChanged) {
        setConfigReloadError(undefined);
        void controller.configSnapshot().then(setCfg).catch((err: unknown) => setStatus(humanMessage(err)));
      }
      statusDirty = true;
      scheduleStatus();
    });
    return () => {
      disposed = true;
      unsub();
      if (fillTimer) {
        clearTimeout(fillTimer);
      }
      if (logTimer) {
        clearTimeout(logTimer);
      }
      if (statusTimer) {
        clearTimeout(statusTimer);
      }
    };
  }, [controller, logSince, paused, refresh]);

  return {  };
}
