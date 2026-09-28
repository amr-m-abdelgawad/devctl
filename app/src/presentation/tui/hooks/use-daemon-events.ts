import { useEffect } from "react";
import { type Controller } from "../../../application/client-runtime.ts";
import type { DevctlConfig } from "../../../domain/config/types.ts";
import type { LogEvent } from "../../../domain/logs/logs.ts";
import { humanMessage } from "../../../shared/errors.ts";
import { ConfigurationChanged, ConfigurationReloadFailed, LogBatch, LogReceived, type BusEvent } from "../../../shared/events.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { reloadFailureMessage } from "../helpers/chrome.ts";
import { appendVisibleLogs } from "../helpers/logs.ts";

import type { Dispatch, SetStateAction } from "react";

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
    const flushLogs = (): void => {
      logTimer = undefined;
      if (pendingLogs.length > 0) {
        const batch = pendingLogs.splice(0, pendingLogs.length);
        setLogs((current) => appendVisibleLogs(current, batch, logSince, cap));
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
        const newest = (ev.payload as { newest?: LogEvent[] }).newest ?? [];
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
      unsub();
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
