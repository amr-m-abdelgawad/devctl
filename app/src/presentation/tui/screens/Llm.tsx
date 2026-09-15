import type { DevctlConfig } from "../../../domain/config/types.ts";
import type { LlmCall, LlmCallPage } from "../../../domain/llm/llm.ts";
import { EmptyState } from "../chrome.tsx";
import { clipText, padClip } from "../helpers/format.ts";
import { formatLlmCaller, formatLlmCost, formatLlmDuration, formatLlmTokens } from "../helpers/llm.ts";
import { MetaBar, ScreenFrame, scrollboxStyle } from "../layout.tsx";
import { type Palette } from "../themes.ts";

const TIME_COL = 9;
const STATUS_COL = 6;
const CALLER_COL = 12;
const DUR_COL = 8;
const TOK_COL = 7;
const COST_COL = 10;
const MODEL_MIN = 10;

function statusColor(palette: Palette, status: LlmCall["status"]): string {
  return status === "error" ? palette.error : palette.success;
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
  const modelWidth = Math.max(MODEL_MIN, width - TIME_COL - STATUS_COL - CALLER_COL - DUR_COL - TOK_COL - COST_COL - 9);
  return (
    <box
      height={1}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={selected ? palette.highlight : undefined}
      onMouseDown={() => {
        onPick();
        onOpen();
      }}
    >
      <text fg={palette.muted}>{padClip(call.timestamp.slice(11, 19) || call.timestamp, TIME_COL)}</text>
      <text fg={statusColor(palette, call.status)}>{padClip(call.status, STATUS_COL)}</text>
      <text fg={palette.text}>{padClip(formatLlmCaller(call.caller), CALLER_COL)}</text>
      <text fg={palette.text}>{padClip(call.model, modelWidth)}</text>
      <text fg={palette.muted}>{padClip(formatLlmDuration(call.durationMs), DUR_COL)}</text>
      <text fg={palette.muted}>{padClip(formatLlmTokens(call.usage), TOK_COL)}</text>
      <text fg={palette.muted}>{padClip(formatLlmCost(call.cost), COST_COL)}</text>
    </box>
  );
}

export function LlmScreen(props: {
  palette: Palette;
  cfg?: DevctlConfig;
  page: LlmCallPage;
  error: string;
  selected: number;
  width: number;
  onPick: (index: number) => void;
  onOpen: (call: LlmCall) => void;
}) {
  const { palette, cfg, page, error, selected, width, onPick, onOpen } = props;
  const enabled = cfg?.llm.enabled === true;
  const calls = page.calls ?? [];
  const errors = page.errors ?? [];
  return (
    <ScreenFrame palette={palette} title="llm">
      <MetaBar
        palette={palette}
        items={[
          { text: enabled ? "enabled" : "off", tone: enabled ? "success" : "idle" },
          { text: `${calls.length} calls`, tone: "info" },
          ...(errors.length > 0 ? [{ text: `${errors.length} source error${errors.length === 1 ? "" : "s"}`, tone: "warning" as const }] : []),
        ]}
        hints={[{ key: "enter", label: "detail" }]}
      />
      {error ? (
        <text fg={palette.error} wrapMode="word">
          {error}
        </text>
      ) : null}
      {errors.map((item) => (
        <text key={item.source} fg={palette.warning} wrapMode="word">
          {`${item.source}: ${clipText(item.message, Math.max(20, width - 4))}`}
        </text>
      ))}
      {!enabled ? (
        <EmptyState palette={palette} title="LLM inspector is off" body="Set llm.enabled: true and add llm.sources (type: litellm) in .devctl/config.yaml." />
      ) : calls.length === 0 ? (
        <EmptyState palette={palette} title="No LLM calls yet" body="The inspector polls LiteLLM spend logs. Start the source service, or set path_prefix / management_endpoint if it sits behind a proxy." />
      ) : (
        <scrollbox focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
          <box flexDirection="column" overflow="hidden">
            {calls.map((call, index) => (
              <CallRow
                key={call.id}
                palette={palette}
                call={call}
                selected={index === selected}
                width={width}
                onPick={() => onPick(index)}
                onOpen={() => onOpen(call)}
              />
            ))}
            {page.hasNext ? (
              <text fg={palette.muted}>{"… older calls omitted"}</text>
            ) : null}
          </box>
        </scrollbox>
      )}
    </ScreenFrame>
  );
}
