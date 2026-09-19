import type { TrafficCall } from "../../../domain/traffic/traffic.ts";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { clipText } from "../helpers/format.ts";
import {
  TRAFFIC_INSPECTOR_JSON_CHARS,
  formatTrafficCaller,
  formatTrafficDuration,
  formatTrafficStatus,
  trafficBodyModeHint,
  trafficPayloadView,
  type TrafficBodyMode,
} from "../helpers/traffic.ts";
import { JsonView } from "./JsonView.tsx";
import { Chip, FieldRow, KeyHints, MetaBar, scrollboxStyle, type KeyHintItem, type MetaChip } from "../layout.tsx";
import { type Palette } from "../themes.ts";

const ERROR_PREVIEW = 96;
const ERROR_FULL = 256;

export function TrafficInspector(props: {
  palette: Palette;
  call?: TrafficCall;
  compact?: boolean;
  bodyMode?: TrafficBodyMode;
  onToggleBody?: () => void;
  onViewTrace?: (traceId: string) => void;
}) {
  const { palette, call, compact = true, bodyMode = "json", onToggleBody, onViewTrace } = props;
  const scale = useDensity();
  if (!call) {
    return <EmptyState palette={palette} title="No hop selected" body="j/k moves the list. enter opens the full payload. r switches pretty JSON and raw." />;
  }
  const traceId = call.traceId?.trim() ?? "";
  const errorText = call.grpcStatus && call.grpcStatus !== "0"
    ? clipText(`grpc-status ${call.grpcStatus}`, compact ? ERROR_PREVIEW : ERROR_FULL)
    : "";
  const body = <JsonBody palette={palette} call={call} compact={compact} bodyMode={bodyMode} />;
  return (
    <box padding={scale.pad} flexGrow={1} flexShrink={1} minWidth={0} minHeight={0} flexDirection="column" overflow="hidden">
      <MetaBar palette={palette} items={inspectorChips(call, bodyMode, onToggleBody)} />
      {errorText !== "" ? (
        <box height={1} overflow="hidden">
          <text fg={palette.error} wrapMode="none">{errorText}</text>
        </box>
      ) : null}
      <FieldRow palette={palette} label="caller" value={formatTrafficCaller(call.caller)} />
      <FieldRow palette={palette} label="route" value={`${call.route} (${call.transport})`} />
      <FieldRow palette={palette} label="method" value={`${call.method} ${call.path}`} />
      <FieldRow palette={palette} label="time" value={call.timestamp} tone="muted" />
      <FieldRow palette={palette} label="request" value={call.requestId || "—"} tone="muted" />
      {compact ? null : <FieldRow palette={palette} label="id" value={call.id} tone="muted" />}
      {compact ? null : <FieldRow palette={palette} label="trace" value={traceId || "—"} tone="muted" />}
      {compact ? (
        <box flexGrow={1} flexShrink={1} minHeight={0} minWidth={0} overflow="hidden">
          <scrollbox focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
            <box flexDirection="column" minWidth={0} width="100%">{body}</box>
          </scrollbox>
        </box>
      ) : body}
      {compact ? (
        <KeyHints palette={palette} hints={compactHints(bodyMode)} />
      ) : (
        <OverlayFooter palette={palette} traceId={traceId} bodyMode={bodyMode} onToggleBody={onToggleBody} onViewTrace={onViewTrace} />
      )}
    </box>
  );
}

function inspectorChips(call: TrafficCall, bodyMode: TrafficBodyMode, onToggleBody?: () => void): MetaChip[] {
  const chips: MetaChip[] = [
    { text: formatTrafficStatus(call), tone: call.status >= 400 || (call.grpcStatus !== undefined && call.grpcStatus !== "0") ? "error" : "success" },
    { text: call.transport, tone: "info" },
    { text: formatTrafficDuration(call.durationMs), tone: "muted" },
    {
      text: bodyMode === "raw" ? "raw" : "json",
      tone: bodyMode === "raw" ? "accent" : "info",
      onMouseDown: onToggleBody,
    },
  ];
  if (call.request?.truncated || call.response?.truncated) {
    chips.push({ text: "truncated", tone: "warning" });
  }
  if (call.request?.omitted || call.response?.omitted) {
    chips.push({ text: "omitted", tone: "ghost" });
  }
  return chips;
}

function compactHints(bodyMode: TrafficBodyMode): KeyHintItem[] {
  return [
    { key: "r", label: trafficBodyModeHint(bodyMode) },
    { key: "enter", label: "full payload" },
    { key: "j/k", label: "hops" },
  ];
}

function JsonBody(props: { palette: Palette; call: TrafficCall; compact: boolean; bodyMode: TrafficBodyMode }) {
  const { palette, call, compact, bodyMode } = props;
  const request = trafficPayloadView(call.request, bodyMode);
  const response = trafficPayloadView(call.response, bodyMode);
  if (request === "" && response === "") {
    return (
      <box flexShrink={0} minWidth={0} width="100%" overflow="hidden">
        <text fg={palette.muted}>{"no request/response body"}</text>
      </box>
    );
  }
  return (
    <box flexShrink={0} flexDirection="column" minWidth={0} width="100%">
      <box height={1} flexShrink={0} overflow="hidden">
        <text fg={palette.muted}>{bodyMode === "raw" ? "raw" : "json"}</text>
      </box>
      {request === "" ? null : (
        <>
          <text fg={palette.muted}>{"request"}</text>
          <JsonView palette={palette} input={request} compact={compact} maxChars={TRAFFIC_INSPECTOR_JSON_CHARS} parseStrings={bodyMode !== "raw"} />
        </>
      )}
      {response === "" ? null : (
        <>
          <text fg={palette.muted}>{"response"}</text>
          <JsonView palette={palette} input={response} compact={compact} maxChars={TRAFFIC_INSPECTOR_JSON_CHARS} parseStrings={bodyMode !== "raw"} />
        </>
      )}
    </box>
  );
}

function OverlayFooter(props: {
  palette: Palette;
  traceId: string;
  bodyMode: TrafficBodyMode;
  onToggleBody?: () => void;
  onViewTrace?: (traceId: string) => void;
}) {
  const { palette, traceId, bodyMode, onToggleBody, onViewTrace } = props;
  const showTrace = traceId !== "" && Boolean(onViewTrace);
  return (
    <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
      {onToggleBody ? (
        <Chip palette={palette} label={`r ${trafficBodyModeHint(bodyMode)}`} tone="accent" onMouseDown={onToggleBody} />
      ) : null}
      {showTrace ? (
        <Chip palette={palette} label="view trace ↵" tone="primary" onMouseDown={() => onViewTrace?.(traceId)} />
      ) : null}
    </box>
  );
}
