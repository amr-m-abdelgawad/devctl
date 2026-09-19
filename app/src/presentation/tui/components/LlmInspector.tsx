import type { LlmCall } from "../../../domain/llm/llm.ts";
import { EmptyState } from "../chrome.tsx";
import { useDensity } from "../density.tsx";
import { clipText } from "../helpers/format.ts";
import {
  LLM_INSPECTOR_JSON_CHARS,
  LLM_INSPECTOR_TURNS,
  formatLlmCaller,
  formatLlmCost,
  formatLlmDuration,
  formatLlmTokenBreakdown,
  llmBodyModeHint,
  llmEffectiveBodyMode,
  llmIsRawSchema,
  llmIsStream,
  llmPathOf,
  llmSourceLabel,
  llmSourceValue,
  llmTurns,
  llmVisibleAttributes,
  type LlmBodyMode,
  type LlmTurn,
} from "../helpers/llm.ts";
import { JsonView } from "./JsonView.tsx";
import { Chip, FieldRow, KeyHints, MetaBar, scrollboxStyle, type KeyHintItem, type MetaChip } from "../layout.tsx";
import { type Palette } from "../themes.ts";

const TWO_COL_MIN = 56;
const ERROR_PREVIEW = 96;

export function LlmInspector(props: {
  palette: Palette;
  call?: LlmCall;
  width: number;
  compact?: boolean;
  bodyMode?: LlmBodyMode;
  onToggleBody?: () => void;
  onViewTrace?: (traceId: string) => void;
}) {
  const { palette, call, width, compact = true, bodyMode = "conversation", onToggleBody, onViewTrace } = props;
  const scale = useDensity();
  if (!call) {
    return <EmptyState palette={palette} title="No call selected" body="j/k moves the list. enter opens the full payload. r shows raw JSON." />;
  }
  const turns = llmTurns(call);
  const shownTurns = compact ? turns.slice(-LLM_INSPECTOR_TURNS) : turns;
  const omitted = compact ? Math.max(0, turns.length - shownTurns.length) : 0;
  const canToggle = turns.length > 0;
  const effective = llmEffectiveBodyMode(call, bodyMode);
  const showConversation = effective === "conversation" && shownTurns.length > 0;
  const path = llmPathOf(call);
  const traceId = call.traceId?.trim() ?? "";
  const errorText = call.error ? clipText(call.error, compact ? ERROR_PREVIEW : call.error.length) : "";
  const body = (
    <>
      {showConversation ? (
        <Transcript palette={palette} turns={shownTurns} omitted={omitted} wide={width >= TWO_COL_MIN} />
      ) : (
        <JsonBody palette={palette} call={call} compact={compact} />
      )}
      {compact ? null : <AttributeList palette={palette} call={call} />}
    </>
  );
  return (
    <box padding={scale.pad} flexGrow={1} flexShrink={1} minWidth={0} minHeight={0} flexDirection="column" overflow="hidden">
      <MetaBar palette={palette} items={inspectorChips(call, canToggle, effective, onToggleBody)} />
      {errorText !== "" ? (
        <box height={1} overflow="hidden">
          <text fg={palette.error} wrapMode="none">{errorText}</text>
        </box>
      ) : null}
      <FieldRow palette={palette} label="caller" value={formatLlmCaller(call.caller)} />
      <FieldRow palette={palette} label={llmSourceLabel(call)} value={llmSourceValue(call)} />
      <FieldRow palette={palette} label="model" value={modelLine(call)} />
      <FieldRow palette={palette} label="time" value={call.timestamp} tone="muted" />
      {path !== "" ? <FieldRow palette={palette} label="path" value={path} tone="muted" /> : null}
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
        <KeyHints palette={palette} hints={compactHints(canToggle, effective)} />
      ) : (
        <OverlayFooter palette={palette} traceId={traceId} canToggle={canToggle} bodyMode={effective} onToggleBody={onToggleBody} onViewTrace={onViewTrace} />
      )}
    </box>
  );
}

function inspectorChips(call: LlmCall, canToggle: boolean, bodyMode: LlmBodyMode, onToggleBody?: () => void): MetaChip[] {
  const chips: MetaChip[] = metricChips(call);
  if (canToggle) {
    chips.push({
      text: bodyMode === "json" ? "json" : "conversation",
      tone: bodyMode === "json" ? "accent" : "info",
      onMouseDown: onToggleBody,
    });
  }
  return chips;
}

function compactHints(canToggle: boolean, bodyMode: LlmBodyMode): KeyHintItem[] {
  const hints: KeyHintItem[] = [];
  if (canToggle) {
    hints.push({ key: "r", label: llmBodyModeHint(bodyMode) });
  }
  hints.push({ key: "enter", label: "full payload" }, { key: "j/k", label: "calls" });
  return hints;
}

function metricChips(call: LlmCall): MetaChip[] {
  const chips: MetaChip[] = [
    { text: call.status, tone: call.status === "error" ? "error" : "success" },
    { text: call.operation, tone: "info" },
    { text: formatLlmDuration(call.durationMs), tone: "muted" },
    { text: formatLlmTokenBreakdown(call.usage), tone: "muted" },
  ];
  if (call.cost !== undefined) {
    chips.push({ text: formatLlmCost(call.cost), tone: "muted" });
  }
  if (llmIsRawSchema(call)) {
    chips.push({ text: "raw", tone: "accent" });
  }
  if (llmIsStream(call)) {
    chips.push({ text: "stream", tone: "ghost" });
  }
  if (call.vendor) {
    chips.push({ text: call.vendor, tone: "ghost" });
  }
  return chips;
}

function modelLine(call: LlmCall): string {
  return call.routedModel && call.routedModel !== call.model ? `${call.model} → ${call.routedModel}` : call.model;
}

function Transcript(props: { palette: Palette; turns: LlmTurn[]; omitted: number; wide: boolean }) {
  const { palette, turns, omitted, wide } = props;
  return (
    <box flexGrow={1} flexDirection="column" overflow="hidden">
      <box height={1} flexShrink={0} overflow="hidden">
        <text fg={palette.muted}>{omitted > 0 ? `conversation  ·  ${omitted} earlier` : "conversation"}</text>
      </box>
      {turns.map((turn, index) => (
        <box key={`${turn.role}-${index}`} flexShrink={0} flexDirection="column" overflow="hidden">
          <text fg={roleColor(palette, turn.role)}>{turn.role}</text>
          <text fg={palette.text} wrapMode={wide ? "word" : "none"}>{turn.content}</text>
        </box>
      ))}
    </box>
  );
}

function JsonBody(props: { palette: Palette; call: LlmCall; compact: boolean }) {
  const { palette, call, compact } = props;
  const hasRequest = call.request !== undefined;
  const hasResponse = call.response !== undefined;
  if (!hasRequest && !hasResponse) {
    return (
      <box flexShrink={0} minWidth={0} width="100%" overflow="hidden">
        <text fg={palette.muted}>{"no request/response body"}</text>
      </box>
    );
  }
  return (
    <box flexShrink={0} flexDirection="column" minWidth={0} width="100%">
      <box height={1} flexShrink={0} overflow="hidden">
        <text fg={palette.muted}>{"json"}</text>
      </box>
      {hasRequest ? (
        <>
          <text fg={palette.muted}>{"request"}</text>
          <JsonView palette={palette} input={call.request} compact={compact} maxChars={LLM_INSPECTOR_JSON_CHARS} />
        </>
      ) : null}
      {hasResponse ? (
        <>
          <text fg={palette.muted}>{"response"}</text>
          <JsonView palette={palette} input={call.response} compact={compact} maxChars={LLM_INSPECTOR_JSON_CHARS} />
        </>
      ) : null}
    </box>
  );
}

function AttributeList(props: { palette: Palette; call: LlmCall }) {
  const attrs = llmVisibleAttributes(props.call);
  if (attrs.length === 0) {
    return null;
  }
  return (
    <box flexShrink={0} flexDirection="column" overflow="hidden">
      <text fg={props.palette.muted}>{"attributes"}</text>
      <JsonView palette={props.palette} input={Object.fromEntries(attrs)} />
    </box>
  );
}

function OverlayFooter(props: {
  palette: Palette;
  traceId: string;
  canToggle: boolean;
  bodyMode: LlmBodyMode;
  onToggleBody?: () => void;
  onViewTrace?: (traceId: string) => void;
}) {
  const { palette, traceId, canToggle, bodyMode, onToggleBody, onViewTrace } = props;
  const showTrace = traceId !== "" && Boolean(onViewTrace);
  if (!canToggle && !showTrace) {
    return null;
  }
  return (
    <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
      {canToggle && onToggleBody ? (
        <Chip palette={palette} label={`r ${llmBodyModeHint(bodyMode)}`} tone="accent" onMouseDown={onToggleBody} />
      ) : null}
      {showTrace ? (
        <Chip palette={palette} label="view trace ↵" tone="primary" onMouseDown={() => onViewTrace?.(traceId)} />
      ) : null}
    </box>
  );
}

function roleColor(palette: Palette, role: string): string {
  const kind = role.toLowerCase();
  if (kind === "assistant") {
    return palette.success;
  }
  if (kind === "system" || kind === "tool") {
    return palette.accent;
  }
  return palette.primary;
}
