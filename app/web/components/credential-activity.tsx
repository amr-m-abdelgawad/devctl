import { useMemo, useState } from "react";
import { authTimeline, summarizeAuthTimeline } from "../../src/domain/identity/auth-timeline.ts";
import { logRecord } from "../../src/domain/logs/logs.ts";
import { useLogSession } from "../hooks/use-log-session.ts";
import { clockMs } from "../format.ts";
import { SearchInput } from "./filters.tsx";
import { Empty, Kpi } from "./primitives.tsx";
import { Badge } from "./ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Button } from "./ui/button.tsx";

export function CredentialActivity() {
  const [search, setSearch] = useState("");
  const query = useMemo(() => ({ source: "auth" }), []);
  const session = useLogSession({ active: true, paused: false, query });
  const events = useMemo(
    () =>
      authTimeline(
        session.events.map((row) =>
          logRecord({
            timestamp: row.timestamp,
            service: row.service,
            source: row.source,
            level: row.level,
            seq: row.seq ?? 0,
            body: typeof row.body === "string" ? row.body : row.message,
            pid: row.pid ?? 0,
          }),
        ),
      ),
    [session.events],
  );
  const summary = summarizeAuthTimeline(events);
  const shown = events.filter((event) =>
    `${event.identity} ${event.audience} ${event.error} ${event.kind}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Refreshes" value={summary.refreshes} />
        <Kpi label="Failures" value={summary.failures} tone={summary.failures ? "destructive" : "muted"} />
        <Kpi label="Identities" value={summary.identities} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Token & identity timeline</CardTitle>
          <SearchInput
            label="Search identity, audience, errors…"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            className="w-full sm:w-80"
          />
        </CardHeader>
        <CardContent>
          {session.error ? (
            <p role="alert" className="text-xs text-destructive">
              {session.error}
            </p>
          ) : null}
          {shown.length ? (
            <div className="credential-events">
              {shown.map((event) => (
                <div key={event.seq}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={event.kind === "failed" ? "destructive" : event.kind === "changed" ? "info" : "success"}>
                      {event.kind}
                    </Badge>
                    <time className="font-mono text-[11px] text-muted-foreground">{clockMs(event.timestamp)}</time>
                  </div>
                  <p className="break-all font-mono text-xs">{event.identity || "Default identity"}</p>
                  <p className="break-all text-xs text-muted-foreground">{event.error || event.audience || "Identity changed"}</p>
                </div>
              ))}
            </div>
          ) : (
            <Empty>{session.loading ? "Loading token activity…" : "No token activity matches this view."}</Empty>
          )}
          {session.hasPrev ? (
            <Button size="sm" variant="outline" disabled={session.loadingOlder} onClick={session.loadOlder}>
              Load older activity
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
