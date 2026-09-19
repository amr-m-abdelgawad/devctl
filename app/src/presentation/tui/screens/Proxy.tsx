import { type DevctlConfig, hasListenPort } from "../../../domain/config/types.ts";
import { secretTemplateLabel } from "../../../domain/config/env-ref.ts";
import type { TrafficCall, TrafficCallPage } from "../../../domain/traffic/traffic.ts";
import { type StatusSnapshot } from "../../../domain/status.ts";
import { EmptyState } from "../chrome.tsx";
import { NARROW_WIDTH } from "../helpers/chrome.ts";
import { clipText, padClip, callerFilterLabel } from "../helpers/format.ts";
import {
  TRAFFIC_CALLER_COL,
  TRAFFIC_CURSOR_COL,
  TRAFFIC_DETAIL_MIN,
  TRAFFIC_LAT_COL,
  TRAFFIC_LIST_MIN,
  TRAFFIC_METHOD_COL,
  TRAFFIC_STATUS_COL,
  TRAFFIC_TIME_COL,
  formatTrafficCaller,
  formatTrafficClock,
  formatTrafficDuration,
  formatTrafficStatus,
  inspectEnabledCount,
  trafficListPaneWidth,
  trafficPreview,
  trafficRowShowsCaller,
  type TrafficBodyMode,
} from "../helpers/traffic.ts";
import { useCallListScroll } from "../hooks/use-call-list.ts";
import { Chip, KeyHints, MetaBar, ROUNDED_BORDER, ScreenFrame, Toolbar, scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { TrafficInspector } from "../components/TrafficInspector.tsx";

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

function statusColor(palette: Palette, call: TrafficCall): string {
  if (call.status >= 500 || (call.grpcStatus !== undefined && call.grpcStatus !== "0" && call.grpcStatus !== "")) {
    return palette.error;
  }
  if (call.status === 0 || call.status >= 400) {
    return palette.warning;
  }
  return palette.success;
}

function RouteRow(props: {
  palette: Palette;
  name: string;
  auth: string;
  identity: string;
  upstream: string;
  match?: string;
  inspect?: boolean;
  onMouseDown?: () => void;
}) {
  const { palette, name, auth, identity, upstream, match, inspect, onMouseDown } = props;
  return (
    <box flexDirection="column" flexShrink={0} overflow="hidden" onMouseDown={onMouseDown}>
      <text fg={palette.text} wrapMode="none">
        {name}
      </text>
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
        <Chip palette={palette} label={auth || "no auth"} tone={authTone(auth)} />
        {identity ? <Chip palette={palette} label={identity} tone="idle" /> : null}
        {inspect ? <Chip palette={palette} label="inspect" tone="accent" /> : null}
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

const ROW_PREFIX = "traffic-row";
const TRAFFIC_ROW_HEIGHT = 1;
const PANE_GUTTER = 4;
const STACK_INSPECTOR_MIN = 12;
const ROUTES_PANE_MIN = 22;
const ROUTES_PANE_MAX = 40;

function CallHeader(props: { palette: Palette; width: number }) {
  const { palette, width } = props;
  const showCaller = trafficRowShowsCaller(width);
  return (
    <box height={1} flexDirection="row" overflow="hidden">
      <text fg={palette.muted}>{padClip("", TRAFFIC_CURSOR_COL)}</text>
      <text fg={palette.muted}>{padClip("time", TRAFFIC_TIME_COL)}</text>
      <text fg={palette.muted}>{padClip("st", TRAFFIC_STATUS_COL)}</text>
      <text fg={palette.muted}>{padClip("verb", TRAFFIC_METHOD_COL)}</text>
      {showCaller ? <text fg={palette.muted}>{padClip("caller", TRAFFIC_CALLER_COL)}</text> : null}
      <text fg={palette.muted}>{padClip("lat", TRAFFIC_LAT_COL)}</text>
    </box>
  );
}

function CallRow(props: {
  palette: Palette;
  call: TrafficCall;
  selected: boolean;
  width: number;
  onPick: () => void;
  onOpen: () => void;
}) {
  const { palette, call, selected, width, onPick, onOpen } = props;
  const showCaller = trafficRowShowsCaller(width);
  return (
    <box
      id={`${ROW_PREFIX}-${call.id}`}
      height={TRAFFIC_ROW_HEIGHT}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={selected ? palette.highlight : undefined}
      onMouseDown={() => {
        if (selected) {
          onOpen();
          return;
        }
        onPick();
      }}
    >
      <text fg={palette.primary}>{padClip(selected ? "›" : " ", TRAFFIC_CURSOR_COL)}</text>
      <text fg={palette.muted}>{padClip(formatTrafficClock(call.timestamp), TRAFFIC_TIME_COL)}</text>
      <text fg={statusColor(palette, call)}>{padClip(formatTrafficStatus(call), TRAFFIC_STATUS_COL)}</text>
      <text fg={palette.text}>{padClip(call.method, TRAFFIC_METHOD_COL)}</text>
      {showCaller ? <text fg={palette.text}>{padClip(formatTrafficCaller(call.caller), TRAFFIC_CALLER_COL)}</text> : null}
      <text fg={palette.muted}>{padClip(formatTrafficDuration(call.durationMs), TRAFFIC_LAT_COL)}</text>
    </box>
  );
}

export function ProxyScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  snap?: StatusSnapshot;
  page: TrafficCallPage;
  error: string;
  caller?: string;
  selected: number;
  width: number;
  bodyMode: TrafficBodyMode;
  onToggleBody: () => void;
  onPick: (index: number) => void;
  onOpen: (call: TrafficCall) => void;
  onSelectRoute?: (route: RouteDetailInfo) => void;
}) {
  const { palette, cfg, snap, page, error, caller = "", selected, width, bodyMode, onToggleBody, onPick, onOpen, onSelectRoute } = props;
  const routes = snap?.proxy.routes ?? [];
  const listenConfigured = hasListenPort(cfg?.proxy.listen);
  const routeCfgByName = new Map((cfg?.proxy.routes ?? []).map((r) => [r.name, r]));
  const matchByName = new Map((cfg?.proxy.routes ?? []).map((r) => [r.name, r.match]));
  const inspectCount = inspectEnabledCount(cfg?.proxy.routes ?? []);
  const calls = page.calls ?? [];
  const selectedCall = calls[selected];
  const stacked = width < NARROW_WIDTH;
  const routesWidth = Math.max(ROUTES_PANE_MIN, Math.min(ROUTES_PANE_MAX, Math.floor(width * 0.28)));
  const trafficWidth = stacked ? width : Math.max(TRAFFIC_LIST_MIN, width - routesWidth - PANE_GUTTER);
  const listWidth = trafficListPaneWidth(trafficWidth, stacked);
  const listInner = Math.max(TRAFFIC_LIST_MIN - 4, listWidth - PANE_GUTTER);
  const inspectorWidth = stacked ? Math.max(TRAFFIC_DETAIL_MIN, trafficWidth - PANE_GUTTER) : Math.max(TRAFFIC_DETAIL_MIN, trafficWidth - listWidth - PANE_GUTTER);
  const { scrollRef, visibleCalls, visibleStart } = useCallListScroll(selected, ROW_PREFIX, calls, selectedCall?.id);
  const preview = selectedCall ? trafficPreview(selectedCall) : "";
  const showInspector = calls.length > 0;
  const filterLabel = callerFilterLabel(caller);

  const trafficList = (
    <box
      flexGrow={showInspector && !stacked ? 0 : 1}
      flexShrink={0}
      minWidth={showInspector && !stacked ? TRAFFIC_LIST_MIN : undefined}
      width={showInspector && !stacked ? listWidth : undefined}
      border
      borderStyle={ROUNDED_BORDER}
      borderColor={palette.borderActive}
      backgroundColor={palette.panel}
      title="traffic"
      titleColor={palette.primary}
      flexDirection="column"
      overflow="hidden"
    >
      <MetaBar
        palette={palette}
        items={[
          { text: snap?.proxy.running ? "RUNNING" : "STOPPED", tone: snap?.proxy.running ? "success" : "idle" },
          { text: `${calls.length} hop${calls.length === 1 ? "" : "s"}`, tone: "info" },
          { text: `${inspectCount} inspect`, tone: inspectCount > 0 ? "accent" : "idle" },
          ...(filterLabel !== "" ? [{ text: filterLabel, tone: "accent" as const }] : []),
        ]}
        hints={[{ key: "enter", label: "detail" }, { key: "r", label: "raw" }, { key: "/caller", label: "filter" }, { key: "n", label: "start" }, { key: "x", label: "stop" }]}
      />
      {error ? <text fg={palette.error} wrapMode="word">{error}</text> : null}
      {calls.length === 0 ? (
        <EmptyState
          palette={palette}
          title={filterLabel !== "" ? "No hops match this filter" : inspectCount === 0 ? "Traffic inspector is off" : "No captured hops yet"}
          body={filterLabel !== ""
            ? `No proxy hops with ${filterLabel}. Clear with /caller.`
            : inspectCount === 0
              ? "Set inspect.enabled: true on a proxy.routes hop (HTTP listen or gRPC listen). Direct 127.0.0.1 sockets that never hit the proxy are invisible. Callers should use ${services.<name>.url} or the gRPC listen port."
              : "Send a request through an inspect-enabled proxy route. Unproxied service-to-service sockets are not captured."}
        />
      ) : (
        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <CallHeader palette={palette} width={listInner} />
          <scrollbox ref={scrollRef} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
            <box flexDirection="column" overflow="hidden">
              {visibleCalls.map((item, index) => (
                <CallRow
                  key={item.id}
                  palette={palette}
                  call={item}
                  selected={visibleStart + index === selected}
                  width={listInner}
                  onPick={() => onPick(visibleStart + index)}
                  onOpen={() => onOpen(item)}
                />
              ))}
              {page.hasNext ? <text fg={palette.muted}>{"… older hops omitted"}</text> : null}
            </box>
          </scrollbox>
        </box>
      )}
    </box>
  );

  const trafficPane = showInspector ? (
    <box flexGrow={1} flexDirection={stacked ? "column" : "row"} overflow="hidden" minWidth={stacked ? undefined : 30}>
      {trafficList}
      <box
        flexGrow={2}
        flexShrink={1}
        flexBasis={0}
        minWidth={stacked ? undefined : TRAFFIC_DETAIL_MIN}
        minHeight={stacked ? STACK_INSPECTOR_MIN : undefined}
        border
        borderStyle={ROUNDED_BORDER}
        borderColor={palette.border}
        backgroundColor={palette.panel}
        title={selectedCall?.route || "hop"}
        titleColor={palette.primary}
        overflow="hidden"
        flexDirection="column"
      >
        {preview !== "" ? (
          <box height={1} overflow="hidden" paddingLeft={1} paddingRight={1}>
            <text fg={palette.muted} wrapMode="none">{clipText(preview, Math.max(8, inspectorWidth - 2))}</text>
          </box>
        ) : null}
        <TrafficInspector palette={palette} call={selectedCall} bodyMode={bodyMode} onToggleBody={onToggleBody} />
      </box>
    </box>
  ) : trafficList;

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
          { text: `${inspectCount} inspect`, tone: inspectCount > 0 ? "accent" : "idle" },
        ]}
      />
      <box flexGrow={1} flexDirection={stacked ? "column" : "row"} overflow="hidden">
        <box
          flexGrow={stacked ? 0 : 0}
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
                        inspect={full?.inspect?.enabled === true}
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
        {trafficPane}
      </box>
      <Toolbar palette={palette} backgroundColor={palette.element} edge="top">
        <KeyHints
          palette={palette}
          hints={[
            { key: "n", label: "start proxy" },
            { key: "x", label: "stop proxy" },
            { key: "r", label: "raw" },
            { key: "/caller", label: "filter" },
            { key: "enter", label: "detail" },
          ]}
        />
      </Toolbar>
    </ScreenFrame>
  );
}
