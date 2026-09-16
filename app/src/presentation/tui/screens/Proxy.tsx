import { type DevctlConfig, hasListenPort } from "../../../domain/config/types.ts";
import { secretTemplateLabel } from "../../../domain/config/env-ref.ts";
import { type ProxyRequestSnapshot,type StatusSnapshot } from "../../../domain/status.ts";
import { EmptyState } from "../chrome.tsx";
import { NARROW_WIDTH } from "../helpers/chrome.ts";
import { padClip } from "../helpers/format.ts";
import { PROXY_DURATION_MISSING, proxyDurationView, proxyRequestPath } from "../helpers/proxy.ts";
import { Chip,KeyHints,MetaBar,ScreenFrame,Toolbar,scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";

// Routes pane still has a max width, but match/upstream wrap instead of
// clipping. Click-through RouteDetailsOverlay remains the full record.
export type RouteDetailInfo = {
  name: string;
  authType: string;
  identityType: string;
  serviceAccount: string;
  audience: string;
  clientId: string;
  clientSecret: string;
  matchHost: string;
  matchPath: string;
  upstream: string;
};

function authTone(auth: string): "info" | "primary" | "idle" {
  const lower = auth.toLowerCase();
  if (lower === "iap") {
    return "info";
  }
  if (lower === "service" || lower === "service_account") {
    return "primary";
  }
  return "idle";
}

function statusColor(palette: Palette, status: number, error?: string): string {
  if (error || status >= 500) {
    return palette.error;
  }
  if (status === 0 || status >= 400) {
    return palette.warning;
  }
  return palette.success;
}

function identityBadge(palette: Palette, identity: string): { label: string; color: string } {
  if (identity.startsWith("sa:")) {
    return { label: "SA", color: palette.primary };
  }
  if (identity !== "") {
    return { label: "USR", color: palette.info };
  }
  return { label: "—", color: palette.muted };
}

// padClip keeps a trailing gutter in every cell. Column widths still need
// room for realistic content plus that gutter (OPTIONS is 7, so METHOD is 8).
const REQ_TIME_COL = 9;
const REQ_METHOD_COL = 8;
const REQ_STATUS_COL = 4;
const REQ_MS_COL = 8;
const REQ_ID_COL = 4;
const REQ_ROUTE_MIN = 8;
const REQ_ROUTE_GAP = 2;
const REQ_ERROR_MAX = 64;
const NO_ROUTE_LABEL = "(none)";

type ReqColumns = {
  showMethod: boolean;
  routeCol: number;
};

function RequestField(props: { width: number; fg: string; text: string }) {
  const { width, fg, text } = props;
  return (
    <box width={width} flexShrink={0} overflow="hidden">
      <text fg={fg} wrapMode="none">
        {padClip(text, width)}
      </text>
    </box>
  );
}

function RequestRow(props: {
  palette: Palette;
  req: ProxyRequestSnapshot;
  cols: ReqColumns;
  onOpenTrace?: (traceId: string) => void;
  onFollowRequest?: (requestId: string) => void;
}) {
  const { palette, req, cols, onOpenTrace, onFollowRequest } = props;
  const color = statusColor(palette, req.status, req.error);
  const statusLabel = req.status > 0 ? String(req.status) : "ERR";
  const badge = identityBadge(palette, req.identity);
  const routeLabel = req.route || NO_ROUTE_LABEL;
  const detail = proxyRequestPath(req, REQ_ERROR_MAX);
  const dur = proxyDurationView(req);
  const traceId = req.traceId;
  // Prefer following the whole request (opens its trace and pre-filters logs on
  // the request id); fall back to the trace-only jump when no follow handler.
  const onMouseDown = onFollowRequest && req.requestId
    ? () => onFollowRequest(req.requestId)
    : traceId && onOpenTrace
      ? () => onOpenTrace(traceId)
      : undefined;
  return (
    <box
      flexShrink={0}
      flexDirection="row"
      alignItems="flex-start"
      overflow="hidden"
      onMouseDown={onMouseDown}
    >
      <RequestField width={REQ_TIME_COL} fg={palette.muted} text={req.timestamp.slice(11, 19)} />
      {cols.showMethod ? <RequestField width={REQ_METHOD_COL} fg={palette.text} text={req.method} /> : null}
      <RequestField width={REQ_STATUS_COL} fg={color} text={statusLabel} />
      <RequestField width={REQ_MS_COL} fg={dur.request === PROXY_DURATION_MISSING ? palette.muted : palette.text} text={dur.request} />
      <RequestField width={REQ_MS_COL} fg={palette.muted} text={dur.hop} />
      <RequestField width={REQ_ID_COL} fg={badge.color} text={badge.label} />
      <RequestField width={cols.routeCol} fg={req.route ? palette.info : palette.muted} text={routeLabel} />
      <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <text fg={req.error ? palette.error : palette.text} wrapMode="char" truncate={false} flexShrink={0} width="100%">
          {detail}
        </text>
      </box>
    </box>
  );
}

function RequestHeader(props: { palette: Palette; cols: ReqColumns }) {
  const { palette, cols } = props;
  return (
    <box height={1} flexDirection="row" overflow="hidden" flexShrink={0} backgroundColor={palette.element}>
      <RequestField width={REQ_TIME_COL} fg={palette.muted} text="TIME" />
      {cols.showMethod ? <RequestField width={REQ_METHOD_COL} fg={palette.muted} text="METHOD" /> : null}
      <RequestField width={REQ_STATUS_COL} fg={palette.muted} text="ST" />
      <RequestField width={REQ_MS_COL} fg={palette.muted} text="REQ" />
      <RequestField width={REQ_MS_COL} fg={palette.muted} text="HOP" />
      <RequestField width={REQ_ID_COL} fg={palette.muted} text="WHO" />
      <RequestField width={cols.routeCol} fg={palette.muted} text="ROUTE" />
      <box flexGrow={1} overflow="hidden">
        <text fg={palette.muted}>PATH</text>
      </box>
    </box>
  );
}

function RouteRow(props: {
  palette: Palette;
  name: string;
  auth: string;
  identity: string;
  upstream: string;
  match?: string;
  onMouseDown?: () => void;
}) {
  const { palette, name, auth, identity, upstream, match, onMouseDown } = props;
  return (
    <box flexDirection="column" flexShrink={0} overflow="hidden" onMouseDown={onMouseDown}>
      <text fg={palette.text} wrapMode="none">
        {name}
      </text>
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
        <Chip palette={palette} label={auth || "no auth"} tone={authTone(auth)} />
        {identity ? <Chip palette={palette} label={identity} tone="idle" /> : null}
      </box>
      {match ? (
        <text fg={palette.muted} wrapMode="word">
          {`match: ${match}`}
        </text>
      ) : null}
      <text fg={palette.muted} wrapMode="word">
        {`→ ${upstream}`}
      </text>
    </box>
  );
}

// Routes are configuration on the left; recent requests are the live,
// side-by-side feed on the right — each its own bordered panel so the two
// never visually run into each other, matching how the services screen
// splits list + detail. Narrow terminals stack them instead.
const ROUTES_PANE_MIN = 26;
const ROUTES_PANE_MAX = 56;
const PANE_GUTTER = 2;
const REQ_SHOW_METHOD_AT = 54;
const REQ_ROUTE_COL_WIDE = 20;
const REQ_ROUTE_COL_TIGHT = 12;

export function ProxyScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  width: number;
  onSelectRoute?: (route: RouteDetailInfo) => void;
  onOpenTrace?: (traceId: string) => void;
  onFollowRequest?: (requestId: string) => void;
}) {
  const { palette, cfg, snap, width, onSelectRoute, onOpenTrace, onFollowRequest } = props;
  const routes = snap?.proxy.routes ?? [];
  const listenConfigured = hasListenPort(cfg?.proxy.listen);
  const routeCfgByName = new Map((cfg?.proxy.routes ?? []).map((r) => [r.name, r]));
  const matchByName = new Map((cfg?.proxy.routes ?? []).map((r) => [r.name, r.match]));
  const recentRequests = snap?.proxy.recentRequests ?? [];
  const requestTotal = snap?.proxy.requestTotal ?? 0;
  const requestErrors = snap?.proxy.requestErrors ?? 0;

  const stacked = width < NARROW_WIDTH;
  const routesWidth = Math.max(ROUTES_PANE_MIN, Math.min(ROUTES_PANE_MAX, Math.floor(width * 0.36)));
  const requestsWidth = stacked ? width - PANE_GUTTER : width - routesWidth - PANE_GUTTER;
  const reqInner = Math.max(20, requestsWidth - 2);
  const showMethod = reqInner >= REQ_SHOW_METHOD_AT;
  const routeColCap = reqInner >= REQ_SHOW_METHOD_AT ? REQ_ROUTE_COL_WIDE : REQ_ROUTE_COL_TIGHT;
  const routeCol = recentRequests.reduce(
    (max, r) => Math.min(routeColCap, Math.max(max, (r.route || NO_ROUTE_LABEL).length + REQ_ROUTE_GAP)),
    REQ_ROUTE_MIN,
  );
  const cols: ReqColumns = { showMethod, routeCol };

  return (
    <ScreenFrame palette={palette} title="proxy">
      <MetaBar
        palette={palette}
        items={[
          { text: snap?.proxy.running ? "RUNNING" : "STOPPED", tone: snap?.proxy.running ? "success" : "idle" },
          ...(listenConfigured
            ? (snap?.proxy.address ? [{ text: snap.proxy.address, tone: "info" as const }] : [])
            : [{ text: "no listen.port", tone: "warning" as const }]),
          { text: `${routes.length} routes`, tone: routes.length > 0 ? "primary" : "idle" },
          ...(requestTotal > 0
            ? [
                { text: `${requestTotal} requests`, tone: "idle" as const },
                ...(requestErrors > 0 ? [{ text: `${requestErrors} errors`, tone: "warning" as const }] : []),
              ]
            : []),
        ]}
      />
      <box flexGrow={1} flexDirection={stacked ? "column" : "row"} overflow="hidden">
        <box
          flexGrow={stacked ? 1 : 0}
          flexBasis={stacked ? 0 : undefined}
          flexShrink={0}
          minWidth={stacked ? undefined : ROUTES_PANE_MIN}
          width={stacked ? undefined : routesWidth}
          minHeight={stacked ? 8 : undefined}
          border
          borderStyle="rounded"
          borderColor={palette.border}
          title="routes"
          titleColor={palette.primary}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          overflow="hidden"
        >
          {routes.length === 0 ? (
            <EmptyState
              palette={palette}
              title={listenConfigured ? "No proxy routes" : "No proxy listen port"}
              body={listenConfigured
                ? "Add routes under proxy.routes or .devctl/proxy/routes.yaml."
                : "Pin proxy.listen.port in .devctl/config.yaml. It is required when proxy.enabled is true."}
            />
          ) : (
            <>
              {onSelectRoute ? (
                <text fg={palette.muted} wrapMode="word">
                  click a route for full details
                </text>
              ) : null}
              <scrollbox focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
              <box flexDirection="column" overflow="hidden" gap={1}>
                {routes.map((r) => {
                  const match = matchByName.get(r.name);
                  const matchText = match && (match.host || match.path) ? `${match.host || "*"}${match.path ? match.path : ""}` : undefined;
                  const full = routeCfgByName.get(r.name);
                  return (
                    <RouteRow
                      key={r.name}
                      palette={palette}
                      name={r.name}
                      auth={r.auth}
                      identity={r.identity}
                      upstream={r.upstream}
                      match={matchText}
                      onMouseDown={
                        onSelectRoute
                          ? () =>
                              onSelectRoute({
                                name: r.name,
                                authType: full?.auth.type || r.auth,
                                identityType: full?.auth.identity.type ?? "",
                                serviceAccount: full?.auth.identity.service_account || full?.auth.service_account || "",
                                audience: full?.auth.audience ?? "",
                                clientId: full?.auth.client_id ?? "",
                                clientSecret: secretTemplateLabel(full?.auth.client_secret ?? "") ?? ((full?.auth.client_secret ?? "").trim() ? "inline" : ""),
                                matchHost: full?.match.host ?? "",
                                matchPath: full?.match.path ?? "",
                                upstream: r.upstream,
                              })
                          : undefined
                      }
                    />
                  );
                })}
              </box>
            </scrollbox>
            </>
          )}
        </box>
        <box
          flexGrow={1}
          flexBasis={0}
          minWidth={stacked ? undefined : 30}
          minHeight={stacked ? 10 : undefined}
          border
          borderStyle="rounded"
          borderColor={palette.borderActive}
          title="requests"
          titleColor={palette.primary}
          flexDirection="column"
          overflow="hidden"
        >
          {recentRequests.length === 0 ? (
            <box paddingLeft={1} paddingRight={1}>
              <text fg={palette.muted} wrapMode="word">
                {listenConfigured
                  ? snap?.proxy.running
                    ? "No requests seen yet. Send one through the proxy to see it show up here — no need to restart or press r."
                    : "Start the proxy, then send it a request to see live traffic here."
                  : "Pin proxy.listen.port, then press n to start. Starting with port 0 fails."}
              </text>
            </box>
          ) : (
            <>
              {onFollowRequest ? (
                <text fg={palette.muted} wrapMode="none">
                  {padClip("click a request to follow it across logs & trace", reqInner)}
                </text>
              ) : null}
              <RequestHeader palette={palette} cols={cols} />
              <scrollbox focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
                <box flexDirection="column" overflow="hidden">
                  {recentRequests.map((req) => (
                    <RequestRow key={req.requestId} palette={palette} req={req} cols={cols} onOpenTrace={onOpenTrace} onFollowRequest={onFollowRequest} />
                  ))}
                </box>
              </scrollbox>
            </>
          )}
        </box>
      </box>
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints
          palette={palette}
          hints={[
            { key: "n", label: "start proxy" },
            { key: "x", label: "stop proxy" },
          ]}
        />
      </Toolbar>
    </ScreenFrame>
  );
}
