import type { TrafficCall, TrafficPayload } from "../../../domain/traffic/traffic.ts";
import { trafficIsError } from "../../../domain/traffic/traffic.ts";

export const TRAFFIC_CURSOR_COL = 2;
export const TRAFFIC_TIME_COL = 9;
export const TRAFFIC_STATUS_COL = 6;
export const TRAFFIC_CALLER_COL = 12;
export const TRAFFIC_METHOD_COL = 7;
export const TRAFFIC_LAT_COL = 7;
export const TRAFFIC_LIST_MIN = 36;
export const TRAFFIC_LIST_MAX = 52;
export const TRAFFIC_DETAIL_MIN = 32;
export const TRAFFIC_INSPECTOR_JSON_CHARS = 1_600;

const LIST_PANE_RATIO = 0.42;
const SHOW_CALLER_AT = 48;
const CLOCK_START = 11;
const CLOCK_END = 19;
const MS_PER_SECOND = 1_000;

export type TrafficBodyMode = "json" | "raw";

export function toggleTrafficBodyMode(mode: TrafficBodyMode): TrafficBodyMode {
  return mode === "raw" ? "json" : "raw";
}

export function trafficBodyModeHint(mode: TrafficBodyMode): string {
  return mode === "json" ? "raw" : "json";
}

export function formatTrafficClock(timestamp: string): string {
  const clock = timestamp.slice(CLOCK_START, CLOCK_END);
  return clock === "" ? timestamp : clock;
}

export function formatTrafficDuration(ms?: number): string {
  if (ms === undefined) {
    return "—";
  }
  if (ms >= MS_PER_SECOND) {
    return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  }
  return `${ms}ms`;
}

export function formatTrafficCaller(caller?: string): string {
  return caller && caller.trim() !== "" ? caller : "—";
}

export function formatTrafficStatus(call: TrafficCall): string {
  if (trafficIsError(call)) {
    return call.grpcStatus && call.grpcStatus !== "0" ? `g${call.grpcStatus}` : String(call.status || "err");
  }
  return String(call.status || "ok");
}

export function trafficRowShowsCaller(paneWidth: number): boolean {
  return paneWidth >= SHOW_CALLER_AT;
}

export function trafficListPaneWidth(termWidth: number, stacked: boolean): number {
  if (stacked) {
    return termWidth;
  }
  return Math.min(TRAFFIC_LIST_MAX, Math.max(TRAFFIC_LIST_MIN, Math.floor(termWidth * LIST_PANE_RATIO)));
}

export function trafficPreview(call: TrafficCall): string {
  return `${call.method} ${call.path}`;
}

export function trafficPayloadView(payload: TrafficPayload | undefined, mode: TrafficBodyMode): string {
  if (!payload) {
    return "";
  }
  if (payload.omitted) {
    return payload.truncated ? "(omitted, truncated at capture cap)" : "(omitted — streamed or over the capture cap)";
  }
  if (mode === "raw") {
    if (payload.data) {
      return payload.data;
    }
    return payload.text ?? "";
  }
  if (payload.text) {
    return payload.text;
  }
  if (payload.data) {
    return payload.data;
  }
  return payload.truncated ? "(truncated)" : "";
}

export function clipTrafficJson(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function inspectEnabledCount(routes: Array<{ inspect?: { enabled?: boolean } }>): number {
  return routes.filter((route) => route.inspect?.enabled === true).length;
}
