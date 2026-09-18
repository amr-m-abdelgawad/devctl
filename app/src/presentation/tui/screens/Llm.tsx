import type { DevctlConfig } from "../../../domain/config/types.ts";
import type { LlmCall, LlmCallPage } from "../../../domain/llm/llm.ts";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { NARROW_WIDTH } from "../helpers/chrome.ts";
import { clipText, padClip } from "../helpers/format.ts";
import {
  LLM_CALLER_COL,
  LLM_CURSOR_COL,
  LLM_DETAIL_MIN,
  LLM_LAT_COL,
  LLM_LIST_MIN,
  LLM_STATUS_COL,
  LLM_TIME_COL,
  LLM_TOK_COL,
  formatLlmCaller,
  formatLlmClock,
  formatLlmDuration,
  formatLlmStatus,
  formatLlmTokens,
  llmListPaneWidth,
  llmModelColumnWidth,
  llmPreview,
  llmRowShowsCaller,
  llmRowShowsTokens,
  type LlmBodyMode,
} from "../helpers/llm.ts";
import { LlmInspector } from "../components/LlmInspector.tsx";
import { useCallListScroll } from "../hooks/use-call-list.ts";
import { MetaBar, ROUNDED_BORDER, scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";

const ROW_PREFIX = "llm-row";
const PANE_GUTTER = 4;
const STACK_INSPECTOR_MIN = 12;

function statusColor(palette: Palette, status: LlmCall["status"]): string {
  return status === "error" ? palette.error : palette.success;
}

function callerFilterLabel(caller: string): string {
  if (caller === "") {
    return "";
  }
  return caller === "-" ? "caller: none" : `caller: ${caller}`;
}

function CallHeader(props: { palette: Palette; width: number }) {
  const { palette, width } = props;
  const showCaller = llmRowShowsCaller(width);
  const showTok = llmRowShowsTokens(width);
  const modelWidth = llmModelColumnWidth(width);
  return (
    <box height={1} flexDirection="row" overflow="hidden">
      <text fg={palette.muted}>{padClip("", LLM_CURSOR_COL)}</text>
      <text fg={palette.muted}>{padClip("time", LLM_TIME_COL)}</text>
      <text fg={palette.muted}>{padClip("st", LLM_STATUS_COL)}</text>
      {showCaller ? <text fg={palette.muted}>{padClip("caller", LLM_CALLER_COL)}</text> : null}
      <text fg={palette.muted}>{padClip("model", modelWidth)}</text>
      <text fg={palette.muted}>{padClip("lat", LLM_LAT_COL)}</text>
      {showTok ? <text fg={palette.muted}>{padClip("tok", LLM_TOK_COL)}</text> : null}
    </box>
  );
}

function CallRow(props: {
  palette: Palette;
  call: LlmCall;
  selected: boolean;
  width: number;
  onPick: () => void;
  onOpen: () => void;
}) {
  const { palette, call, selected, width, onPick, onOpen } = props;
  const scale = useDensity();
  const showCaller = llmRowShowsCaller(width);
  const showTok = llmRowShowsTokens(width);
  const modelWidth = llmModelColumnWidth(width);
  return (
    <box
      id={`${ROW_PREFIX}-${call.id}`}
      height={scale.rowH}
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
      <text fg={palette.primary}>{padClip(selected ? "›" : " ", LLM_CURSOR_COL)}</text>
      <text fg={palette.muted}>{padClip(formatLlmClock(call.timestamp), LLM_TIME_COL)}</text>
      <text fg={statusColor(palette, call.status)}>{padClip(formatLlmStatus(call.status), LLM_STATUS_COL)}</text>
      {showCaller ? <text fg={palette.text}>{padClip(formatLlmCaller(call.caller), LLM_CALLER_COL)}</text> : null}
      <text fg={palette.text}>{padClip(call.model, modelWidth)}</text>
      <text fg={palette.muted}>{padClip(formatLlmDuration(call.durationMs), LLM_LAT_COL)}</text>
      {showTok ? <text fg={palette.muted}>{padClip(formatLlmTokens(call.usage), LLM_TOK_COL)}</text> : null}
    </box>
  );
}

export function LlmScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  page: LlmCallPage;
  error: string;
  caller?: string;
  selected: number;
  width: number;
  bodyMode: LlmBodyMode;
  onToggleBody: () => void;
  onPick: (index: number) => void;
  onOpen: (call: LlmCall) => void;
}) {
  const { palette, cfg, page, error, caller = "", selected, width, bodyMode, onToggleBody, onPick, onOpen } = props;
  const enabled = cfg?.llm.enabled === true;
  const calls = page.calls ?? [];
  const errors = page.errors ?? [];
  const filterLabel = callerFilterLabel(caller);
  const selectedCall = calls[selected];
  const stacked = width < NARROW_WIDTH;
  const listWidth = llmListPaneWidth(width, stacked);
  const listInner = Math.max(LLM_LIST_MIN - 4, listWidth - PANE_GUTTER);
  const inspectorWidth = stacked ? Math.max(LLM_DETAIL_MIN, width - PANE_GUTTER) : Math.max(LLM_DETAIL_MIN, width - listWidth - PANE_GUTTER);
  const { scrollRef, visibleCalls, visibleStart } = useCallListScroll(selected, ROW_PREFIX, calls, selectedCall?.id);
  const preview = selectedCall ? llmPreview(selectedCall) : "";
  const showInspector = enabled && calls.length > 0;

  const list = (
    <box
      flexGrow={showInspector && !stacked ? 0 : 1}
      flexShrink={0}
      minWidth={showInspector && !stacked ? LLM_LIST_MIN : undefined}
      width={showInspector && !stacked ? listWidth : undefined}
      border
      borderStyle={ROUNDED_BORDER}
      borderColor={palette.borderActive}
      backgroundColor={palette.panel}
      title="llm"
      titleColor={palette.primary}
      flexDirection="column"
      overflow="hidden"
    >
      <MetaBar
        palette={palette}
        items={[
          { text: enabled ? "enabled" : "off", tone: enabled ? "success" : "idle" },
          { text: `${calls.length} call${calls.length === 1 ? "" : "s"}`, tone: "info" },
          ...(filterLabel !== "" ? [{ text: filterLabel, tone: "accent" as const }] : []),
          ...(errors.length > 0 ? [{ text: `${errors.length} source error${errors.length === 1 ? "" : "s"}`, tone: "warning" as const }] : []),
        ]}
        hints={[{ key: "enter", label: "detail" }, { key: "r", label: "json" }, { key: "/caller", label: "filter" }]}
      />
      {error ? (
        <text fg={palette.error} wrapMode="word">{error}</text>
      ) : null}
      {errors.map((item) => (
        <text key={item.source} fg={palette.warning} wrapMode="word">
          {`${item.source}: ${clipText(item.message, Math.max(20, listInner - 2))}`}
        </text>
      ))}
      {!enabled ? (
        <EmptyState palette={palette} title="LLM inspector is off" body="Set llm.enabled: true and add llm.sources (type: litellm or proxy) in .devctl/config.yaml." />
      ) : calls.length === 0 ? (
        filterLabel !== "" ? (
          <EmptyState palette={palette} title="No calls match this filter" body={`No LLM calls with ${filterLabel}. Clear with /caller.`} />
        ) : (
          <EmptyState palette={palette} title="No LLM calls yet" body="The inspector reads LiteLLM spend logs and captures tagged proxy completion routes. Start the source, or POST through a type: proxy via.route." />
        )
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
              {page.hasNext ? <text fg={palette.muted}>{"… older calls omitted"}</text> : null}
            </box>
          </scrollbox>
        </box>
      )}
    </box>
  );

  if (!showInspector) {
    return list;
  }

  return (
    <box flexGrow={1} flexDirection={stacked ? "column" : "row"} overflow="hidden">
      {list}
      <box
        flexGrow={2}
        minWidth={stacked ? undefined : LLM_DETAIL_MIN}
        minHeight={stacked ? STACK_INSPECTOR_MIN : undefined}
        border
        borderStyle={ROUNDED_BORDER}
        borderColor={palette.border}
        backgroundColor={palette.panel}
        title={selectedCall?.model || "call"}
        titleColor={palette.primary}
        overflow="hidden"
        flexDirection="column"
      >
        {preview !== "" ? (
          <box height={1} overflow="hidden" paddingLeft={1} paddingRight={1}>
            <text fg={palette.muted} wrapMode="none">{clipText(preview, Math.max(8, inspectorWidth - 2))}</text>
          </box>
        ) : null}
        <LlmInspector palette={palette} call={selectedCall} width={inspectorWidth} bodyMode={bodyMode} onToggleBody={onToggleBody} />
      </box>
    </box>
  );
}
