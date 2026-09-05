import { EmptyState } from "../chrome.tsx";
import { clipText, NARROW_WIDTH, padClip } from "../helpers.ts";
import { Chip, KeyHints, MetaBar, ScreenFrame, Toolbar, scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type DevctlConfig } from "../../../adapters/config/index.ts";
import { type ProxyRequestSnapshot, type StatusSnapshot } from "../../../types.ts";

// Routes pane still has a max width, but match/upstream wrap instead of
// clipping. Click-through RouteDetailsOverlay remains the full record.
export type RouteDetailInfo = {
  name: string;
  authType: string;
  identityType: string;
  serviceAccount: string;
  audience: string;
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

// Every column carries at least one character of slack over its realistic
// max content — padClip only pads when content is shorter than the column,
// so a value that exactly fills its width would glue onto the next column
// with no gap (e.g. the 7-char method OPTIONS, or a route name sized to fit
// exactly).
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
  showDur: boolean;
  routeCol: number;
};

function RequestRow(props: { palette: Palette; req: ProxyRequestSnapshot; cols: ReqColumns }) {
  const { palette, req, cols } = props;
  const color = statusColor(palette, req.status, req.error);
  const statusLabel = req.status > 0 ? String(req.status) : "ERR";
  const badge = identityBadge(palette, req.identity);
  const routeLabel = req.route || NO_ROUTE_LABEL;
  const detail = req.error ? `${req.path} — ${clipText(req.error, REQ_ERROR_MAX)}` : req.path;
  return (
    <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
      <box width={REQ_TIME_COL} flexShrink={0} overflow="hidden">
        <text fg={palette.muted}>{req.timestamp.slice(11, 19)}</text>
      </box>
      {cols.showMethod ? (
        <box width={REQ_METHOD_COL} flexShrink={0} overflow="hidden">
          <text fg={palette.text} wrapMode="none">
            {padClip(req.method, REQ_METHOD_COL)}
          </text>
        </box>
      ) : null}
      <box width={REQ_STATUS_COL} flexShrink={0} overflow="hidden">
        <text fg={color} wrapMode="none">
          {padClip(statusLabel, REQ_STATUS_COL)}
        </text>
      </box>
      {cols.showDur ? (
        <box width={REQ_MS_COL} flexShrink={0} overflow="hidden">
          <text fg={palette.muted} wrapMode="none">
            {padClip(`${req.durationMs}ms`, REQ_MS_COL)}
          </text>
        </box>
      ) : null}
      <box width={REQ_ID_COL} flexShrink={0} overflow="hidden">
        <text fg={badge.color} wrapMode="none">
          {padClip(badge.label, REQ_ID_COL)}
        </text>
      </box>
      <box width={cols.routeCol} flexShrink={0} overflow="hidden">
        <text fg={req.route ? palette.info : palette.muted} wrapMode="none">
          {padClip(routeLabel, cols.routeCol)}
        </text>
      </box>
      <box flexGrow={1} overflow="hidden">
        <text fg={req.error ? palette.error : palette.text} wrapMode="none">
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
      <box width={REQ_TIME_COL} flexShrink={0} overflow="hidden">
        <text fg={palette.muted}>{padClip("TIME", REQ_TIME_COL)}</text>
      </box>
      {cols.showMethod ? (
        <box width={REQ_METHOD_COL} flexShrink={0} overflow="hidden">
          <text fg={palette.muted}>{padClip("METHOD", REQ_METHOD_COL)}</text>
        </box>
      ) : null}
      <box width={REQ_STATUS_COL} flexShrink={0} overflow="hidden">
        <text fg={palette.muted}>{padClip("ST", REQ_STATUS_COL)}</text>
      </box>
      {cols.showDur ? (
        <box width={REQ_MS_COL} flexShrink={0} overflow="hidden">
          <text fg={palette.muted}>{padClip("DUR", REQ_MS_COL)}</text>
        </box>
      ) : null}
      <box width={REQ_ID_COL} flexShrink={0} overflow="hidden">
        <text fg={palette.muted}>{padClip("WHO", REQ_ID_COL)}</text>
      </box>
      <box width={cols.routeCol} flexShrink={0} overflow="hidden">
        <text fg={palette.muted}>{padClip("ROUTE", cols.routeCol)}</text>
      </box>
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
const REQ_SHOW_METHOD_AT = 46;
const REQ_SHOW_DUR_AT = 54;
const REQ_ROUTE_COL_WIDE = 20;
const REQ_ROUTE_COL_TIGHT = 12;

export function ProxyScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  width: number;
  onSelectRoute?: (route: RouteDetailInfo) => void;
}) {
  const { palette, cfg, snap, width, onSelectRoute } = props;
  const routes = snap?.proxy.routes ?? [];
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
  const showDur = reqInner >= REQ_SHOW_DUR_AT;
  const routeColCap = reqInner >= REQ_SHOW_METHOD_AT ? REQ_ROUTE_COL_WIDE : REQ_ROUTE_COL_TIGHT;
  const routeCol = recentRequests.reduce(
    (max, r) => Math.min(routeColCap, Math.max(max, (r.route || NO_ROUTE_LABEL).length + REQ_ROUTE_GAP)),
    REQ_ROUTE_MIN,
  );
  const cols: ReqColumns = { showMethod, showDur, routeCol };

  return (
    <ScreenFrame palette={palette} title="proxy">
      <MetaBar
        palette={palette}
        items={[
          { text: snap?.proxy.running ? "RUNNING" : "STOPPED", tone: snap?.proxy.running ? "success" : "idle" },
          ...(snap?.proxy.address ? [{ text: snap.proxy.address, tone: "info" as const }] : []),
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
            <EmptyState palette={palette} title="No proxy routes" body="Add routes under proxy.routes or .devctl/proxy/routes.yaml." />
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
                {snap?.proxy.running
                  ? "No requests seen yet. Send one through the proxy to see it show up here — no need to restart or press r."
                  : "Start the proxy, then send it a request to see live traffic here."}
              </text>
            </box>
          ) : (
            <>
              <RequestHeader palette={palette} cols={cols} />
              <scrollbox focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
                <box flexDirection="column" overflow="hidden">
                  {recentRequests.map((req) => (
                    <RequestRow key={req.requestId} palette={palette} req={req} cols={cols} />
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
