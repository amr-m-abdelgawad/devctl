import { describe, expect, test } from "bun:test";
import { logRecord } from "../../../domain/logs/record.ts";
import { authTimeline, parseAuthEvent, summarizeAuthTimeline } from "./auth-timeline.ts";

function authLog(seq: number, message: string, level = "INFO") {
  return logRecord({ seq, service: "auth", source: "auth", level, message, timestamp: `2026-09-16T10:00:0${seq}.000Z` });
}

describe("parseAuthEvent", () => {
  test("parses a refresh with its audience", () => {
    const event = parseAuthEvent(authLog(1, "token refreshed identity=sa:api@proj.iam audience=https://svc.run.app"));
    expect(event).toMatchObject({ kind: "refreshed", identity: "sa:api@proj.iam", audience: "https://svc.run.app" });
  });

  test("parses a legacy refresh without an audience", () => {
    const event = parseAuthEvent(authLog(1, "token refreshed identity=sa:api@proj.iam"));
    expect(event).toMatchObject({ kind: "refreshed", identity: "sa:api@proj.iam", audience: "" });
  });

  test("distinguishes one identity refreshed for two audiences", () => {
    const a = parseAuthEvent(authLog(1, "token refreshed identity=user audience=aud-a"));
    const b = parseAuthEvent(authLog(2, "token refreshed identity=user audience=aud-b"));
    expect(a?.audience).toBe("aud-a");
    expect(b?.audience).toBe("aud-b");
  });

  test("parses a failure with audience and error", () => {
    const event = parseAuthEvent(authLog(2, "token refresh failed identity=user audience=aud-1: unauthorized_client", "WARN"));
    expect(event).toMatchObject({ kind: "failed", identity: "user", audience: "aud-1", error: "unauthorized_client" });
  });

  test("parses an authentication change", () => {
    const event = parseAuthEvent(authLog(3, "authentication changed user=me@example.com"));
    expect(event).toMatchObject({ kind: "changed", identity: "me@example.com" });
  });

  test("returns undefined for an unrelated auth line", () => {
    expect(parseAuthEvent(authLog(4, "some other auth note"))).toBeUndefined();
  });
});

describe("authTimeline", () => {
  test("keeps only auth-source lines and orders newest first", () => {
    const logs = [
      authLog(1, "token refreshed identity=a"),
      logRecord({ seq: 2, service: "api", source: "stdout", message: "token refreshed identity=b" }),
      authLog(3, "token refresh failed identity=a audience=x: boom", "WARN"),
    ];
    const events = authTimeline(logs);
    expect(events.map((e) => e.seq)).toEqual([3, 1]);
  });

  test("summarizes refreshes, failures, and distinct identities", () => {
    const events = authTimeline([
      authLog(1, "token refreshed identity=a"),
      authLog(2, "token refreshed identity=b"),
      authLog(3, "token refresh failed identity=a audience=x: boom", "WARN"),
    ]);
    expect(summarizeAuthTimeline(events)).toEqual({ refreshes: 2, failures: 1, identities: 2 });
  });
});
