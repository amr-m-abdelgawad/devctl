import { useMemo } from "react";
import { type LogRecord } from "../../../domain/logs/logs.ts";
import { type CredentialsSnapshot } from "../../../domain/status.ts";
import { EmptyState } from "../chrome.tsx";
import { clipText, padClip } from "../helpers/format.ts";
import { authTimeline, summarizeAuthTimeline, type AuthEventKind, type AuthTimelineEvent } from "../helpers/auth-timeline.ts";
import { Chip, KeyHints, ScreenFrame, Toolbar, scrollboxStyle } from "../layout.tsx";
import { serviceColor, type Palette } from "../themes.ts";

const IDENTITY_COL = 22;
const TIME_COL = 9;

function kindGlyph(kind: AuthEventKind): string {
  if (kind === "failed") {
    return "✗";
  }
  if (kind === "changed") {
    return "●";
  }
  return "✓";
}

function kindColor(palette: Palette, kind: AuthEventKind): string {
  if (kind === "failed") {
    return palette.error;
  }
  if (kind === "changed") {
    return palette.info;
  }
  return palette.success;
}

function EventRow(props: { palette: Palette; event: AuthTimelineEvent; width: number }) {
  const { palette, event, width } = props;
  const identity = event.identity || "(default)";
  const trailing = event.kind === "failed" ? event.error : event.audience;
  const trailWidth = Math.max(8, width - TIME_COL - 2 - IDENTITY_COL - 2);
  return (
    <box flexDirection="row" flexShrink={0} overflow="hidden">
      <text fg={palette.muted} wrapMode="none">{padClip(event.timestamp.slice(11, 19), TIME_COL)}</text>
      <text fg={kindColor(palette, event.kind)} wrapMode="none">{`${kindGlyph(event.kind)} `}</text>
      <text fg={serviceColor(identity, palette)} wrapMode="none">{padClip(clipText(identity, IDENTITY_COL), IDENTITY_COL)}</text>
      <text fg={event.kind === "failed" ? palette.error : palette.muted} wrapMode="none">{padClip(clipText(trailing, trailWidth), trailWidth)}</text>
    </box>
  );
}

export function TokensScreen(props: {
  palette: Palette;
  credentials?: CredentialsSnapshot;
  logs: LogRecord[];
  width: number;
}) {
  const { palette, credentials, logs, width } = props;
  const events = useMemo(() => authTimeline(logs), [logs]);
  const summary = useMemo(() => summarizeAuthTimeline(events), [events]);
  const entries = credentials?.entries ?? [];
  const validEntries = entries.filter((e) => e.valid);
  const nextExpiry = validEntries
    .map((e) => e.expires_at)
    .filter((v) => v !== "")
    .sort()[0];

  return (
    <ScreenFrame palette={palette} title="tokens">
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
        {validEntries.length > 0 ? <Chip palette={palette} label={`${validEntries.length} valid`} tone="success" /> : null}
        {entries.length - validEntries.length > 0 ? <Chip palette={palette} label={`${entries.length - validEntries.length} expired`} tone="warning" /> : null}
        {nextExpiry ? <Chip palette={palette} label={`next expiry ${nextExpiry.slice(11, 19) || nextExpiry}`} tone="info" /> : null}
        {summary.refreshes > 0 ? <Chip palette={palette} label={`${summary.refreshes} refreshes`} tone="idle" /> : null}
        {summary.failures > 0 ? <Chip palette={palette} label={`${summary.failures} failures`} tone="error" /> : null}
      </box>
      <text fg={palette.muted} wrapMode="word">
        Token mint, refresh, and identity events over this session. Correlated by identity, audience, and time — never by request. Tokens are never shown.
      </text>
      <box height={1} flexShrink={0} />
      {events.length === 0 ? (
        <EmptyState
          palette={palette}
          title="No token activity yet"
          body="Auth events appear when a route mints or refreshes a Google / IAP token. Send a request through a proxy route that needs auth."
        />
      ) : (
        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <box height={1} flexDirection="row" overflow="hidden" flexShrink={0} backgroundColor={palette.element}>
            <text fg={palette.muted} wrapMode="none">{padClip("TIME", TIME_COL)}</text>
            <text fg={palette.muted} wrapMode="none">{"  "}</text>
            <text fg={palette.muted} wrapMode="none">{padClip("IDENTITY", IDENTITY_COL)}</text>
            <text fg={palette.muted} wrapMode="none">AUDIENCE / ERROR</text>
          </box>
          <scrollbox focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
            <box flexDirection="column" overflow="hidden">
              {events.map((event) => (
                <EventRow key={`${event.seq}`} palette={palette} event={event} width={width} />
              ))}
            </box>
          </scrollbox>
        </box>
      )}
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints palette={palette} hints={[{ key: "/refresh", label: "mint again" }, { key: "/credentials", label: "store status" }]} />
      </Toolbar>
    </ScreenFrame>
  );
}
