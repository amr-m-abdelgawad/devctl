import { logMessage } from "../../../domain/logs/display.ts";
import { type LogRecord } from "../../../domain/logs/logs.ts";

// The auth log source produced by IdentityCoordinator. These lines are the only
// standalone signal available for a token timeline today — the underlying bus
// events are not request/trace correlated, so events are keyed by identity,
// audience, and time, never by request id.
export const AUTH_LOG_SOURCE = "auth";

export type AuthEventKind = "refreshed" | "failed" | "changed";

export type AuthTimelineEvent = {
  seq: number;
  timestamp: string;
  kind: AuthEventKind;
  identity: string;
  audience: string;
  error: string;
};

const REFRESHED_RE = /^token refreshed identity=(.*)$/;
const FAILED_RE = /^token refresh failed identity=(\S*) audience=(\S*): (.*)$/;
const CHANGED_RE = /^authentication changed user=(.*)$/;

// Parses one auth log line into a typed event. Returns undefined for a line that
// is not one of the three known auth shapes, so unrelated auth-source lines are
// skipped rather than shown as blank rows.
export function parseAuthEvent(record: LogRecord): AuthTimelineEvent | undefined {
  const message = logMessage(record).trim();
  const failed = FAILED_RE.exec(message);
  if (failed) {
    return { seq: record.seq, timestamp: record.timestamp, kind: "failed", identity: failed[1] ?? "", audience: failed[2] ?? "", error: failed[3] ?? "" };
  }
  const refreshed = REFRESHED_RE.exec(message);
  if (refreshed) {
    return { seq: record.seq, timestamp: record.timestamp, kind: "refreshed", identity: refreshed[1] ?? "", audience: "", error: "" };
  }
  const changed = CHANGED_RE.exec(message);
  if (changed) {
    return { seq: record.seq, timestamp: record.timestamp, kind: "changed", identity: changed[1] ?? "", audience: "", error: "" };
  }
  return undefined;
}

// Extracts the auth timeline from a log buffer: auth-source lines that parse as a
// known event, newest first.
export function authTimeline(logs: LogRecord[]): AuthTimelineEvent[] {
  const events: AuthTimelineEvent[] = [];
  for (const record of logs) {
    if (record.source !== AUTH_LOG_SOURCE) {
      continue;
    }
    const event = parseAuthEvent(record);
    if (event) {
      events.push(event);
    }
  }
  return events.sort((a, b) => b.seq - a.seq);
}

export type AuthTimelineSummary = {
  refreshes: number;
  failures: number;
  identities: number;
};

export function summarizeAuthTimeline(events: AuthTimelineEvent[]): AuthTimelineSummary {
  const identities = new Set<string>();
  let refreshes = 0;
  let failures = 0;
  for (const event of events) {
    if (event.identity !== "") {
      identities.add(event.identity);
    }
    if (event.kind === "refreshed") {
      refreshes += 1;
    } else if (event.kind === "failed") {
      failures += 1;
    }
  }
  return { refreshes, failures, identities: identities.size };
}
