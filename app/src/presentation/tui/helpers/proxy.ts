import { clipText, formatDurationMs } from "./format.ts";

export const PROXY_DURATION_MISSING = "—";

export type ProxyDurationView = {
  readonly request: string;
  readonly hop: string;
};

export function proxyDurationView(req: { durationMs: number; traceDurationMs?: number }): ProxyDurationView {
  const hop = formatDurationMs(req.durationMs);
  if (req.traceDurationMs === undefined) {
    return { request: PROXY_DURATION_MISSING, hop };
  }
  return { request: formatDurationMs(req.traceDurationMs), hop };
}

export function proxyRequestPath(req: { path: string; error?: string }, errorMax: number): string {
  if (!req.error) {
    return req.path;
  }
  return `${req.path} — ${clipText(req.error, errorMax)}`;
}
