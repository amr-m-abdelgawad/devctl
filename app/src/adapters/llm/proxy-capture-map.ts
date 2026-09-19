import {
  LLM_OPERATION_CHAT,
  LLM_OPERATION_COMPLETION,
  LLM_OPERATION_EMBEDDING,
  LLM_OPERATION_OTHER,
  LLM_STATUS_ERROR,
  LLM_STATUS_OK,
  type LlmCallIngest,
  type LlmOperation,
  type LlmUsage,
} from "../../domain/llm/llm.ts";
import { splitSseFrames, sseEventData } from "../../domain/traffic/sse-frames.ts";
import { asRecord, firstNumber, firstString, parseJsonish } from "./json.ts";

const HTTP_ERROR_MIN = 400;

// Everything the sink knows about one captured proxy request. Bodies are the
// bounded buffers the proxy teed; `requestOmitted`/`responseTruncated` say when
// a body was streamed instead of buffered or cut at the cap, so the mapper
// records the fact instead of presenting an empty/partial body as complete.
export type ProxyCaptureInput = {
  source: string;
  route: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  traceId?: string;
  timestamp: string;
  requestBody?: string;
  requestOmitted?: boolean;
  responseBody?: string;
  responseTruncated?: boolean;
  responseContentType: string;
  caller?: string;
  // When true, the path did not match the OpenAI completion hints. Store the
  // parsed JSON (or raw SSE text) instead of reassembling a chat.completion,
  // and extract model/usage/finish_reason only when those standard keys exist.
  raw?: boolean;
};

// Map a captured OpenAI-compatible completion (JSON or reassembled SSE) into the
// store's ingest shape. `id` is the proxy request id, never the upstream
// response id — two calls that share a cached/replayed completion id would
// otherwise collide under the store's replace-by-id.
export function mapProxyCapture(input: ProxyCaptureInput): LlmCallIngest {
  const request = parseJsonish(input.requestBody);
  const isSse = input.responseContentType.toLowerCase().includes("text/event-stream");
  const response = capturedResponse(input, isSse);
  const reqRec = asRecord(request);
  const respRec = asRecord(response);

  const requestedModel = firstString(reqRec, ["model"]);
  const routedModel = firstString(respRec, ["model"]);
  const errText = errorText(respRec, input.status);
  const failed = input.status >= HTTP_ERROR_MIN || errText !== "";
  const finishReason = capturedFinishReason(respRec, input.raw === true);

  return {
    id: input.requestId,
    source: input.source,
    sourceType: "proxy",
    timestamp: input.timestamp,
    durationMs: input.durationMs,
    status: failed ? LLM_STATUS_ERROR : LLM_STATUS_OK,
    error: errText === "" ? undefined : errText,
    model: requestedModel || routedModel || "unknown",
    routedModel: routedModel !== "" && routedModel !== requestedModel ? routedModel : undefined,
    vendor: undefined,
    operation: operationFor(input.path, reqRec),
    usage: usageOf(respRec),
    cost: undefined,
    caller: input.caller,
    request: input.requestOmitted ? undefined : (request ?? undefined),
    response: response ?? undefined,
    attributes: {
      capture: "proxy",
      route: input.route,
      method: input.method,
      path: input.path,
      status: input.status,
      stream: boolField(reqRec, "stream") || isSse,
      content_type: input.responseContentType || undefined,
      finish_reason: finishReason || undefined,
      response_id: firstString(respRec, ["id"]) || undefined,
      request_omitted: input.requestOmitted ? true : undefined,
      response_truncated: input.responseTruncated ? true : undefined,
      schema: input.raw ? "raw" : undefined,
    },
    requestId: input.requestId,
    traceId: input.traceId,
  };
}

function capturedResponse(input: ProxyCaptureInput, isSse: boolean): unknown {
  if (input.raw) {
    return rawResponseBody(input.responseBody, isSse);
  }
  if (isSse) {
    return assembleSseCompletion(input.responseBody ?? "");
  }
  return parseJsonish(input.responseBody);
}

function rawResponseBody(body: string | undefined, isSse: boolean): unknown {
  if (isSse) {
    return body === undefined || body === "" ? undefined : body;
  }
  return parseJsonish(body);
}

function capturedFinishReason(response: Record<string, unknown> | undefined, raw: boolean): string {
  const fromChoices = finishReasonOf(response);
  if (fromChoices !== "" || !raw) {
    return fromChoices;
  }
  return firstString(response, ["finish_reason"]);
}

// Reassemble a streamed chat/text completion from its SSE frames into a normal
// completion-response object, so the detail view is identical to a non-streamed
// call. Tolerates malformed lines, a partial trailing frame (client
// disconnect), and a missing `[DONE]`.
export function assembleSseCompletion(raw: string): Record<string, unknown> | undefined {
  const frames = sseDataFrames(raw);
  if (frames.length === 0) {
    return undefined;
  }
  let id = "";
  let model = "";
  let usage: unknown;
  const contents = new Map<number, string>();
  const roles = new Map<number, string>();
  const finishReasons = new Map<number, string>();
  const toolCalls = new Map<number, Map<number, ToolCallAcc>>();

  for (const frame of frames) {
    const chunk = asRecord(parseJsonish(frame));
    if (!chunk) {
      continue;
    }
    if (id === "") id = firstString(chunk, ["id"]);
    if (model === "") model = firstString(chunk, ["model"]);
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choiceRaw of choices) {
      const choice = asRecord(choiceRaw);
      if (!choice) continue;
      const index = firstNumber(choice, ["index"]) ?? 0;
      const delta = asRecord(choice.delta) ?? {};
      const role = firstString(delta, ["role"]);
      if (role !== "" && !roles.has(index)) roles.set(index, role);
      const piece = firstString(delta, ["content"]) || firstString(choice, ["text"]);
      if (piece !== "") contents.set(index, (contents.get(index) ?? "") + piece);
      accumulateToolCalls(toolCalls, index, delta.tool_calls);
      const finish = firstString(choice, ["finish_reason"]);
      if (finish !== "") finishReasons.set(index, finish);
    }
  }

  const indices = new Set<number>([...contents.keys(), ...roles.keys(), ...finishReasons.keys(), ...toolCalls.keys()]);
  if (indices.size === 0) indices.add(0);
  const choices = [...indices].sort((a, b) => a - b).map((index) => {
    const message: Record<string, unknown> = {
      role: roles.get(index) || "assistant",
      content: contents.get(index) ?? "",
    };
    const tools = finalizeToolCalls(toolCalls.get(index));
    if (tools.length > 0) message.tool_calls = tools;
    return { index, message, finish_reason: finishReasons.get(index) || undefined };
  });

  const assembled: Record<string, unknown> = { object: "chat.completion", choices };
  if (id !== "") assembled.id = id;
  if (model !== "") assembled.model = model;
  if (usage !== undefined) assembled.usage = usage;
  return assembled;
}

type ToolCallAcc = { id?: string; type?: string; name?: string; arguments: string };

function accumulateToolCalls(store: Map<number, Map<number, ToolCallAcc>>, choiceIndex: number, raw: unknown): void {
  if (!Array.isArray(raw)) {
    return;
  }
  const byIndex = store.get(choiceIndex) ?? new Map<number, ToolCallAcc>();
  for (const entry of raw) {
    const call = asRecord(entry);
    if (!call) continue;
    const index = firstNumber(call, ["index"]) ?? byIndex.size;
    const acc = byIndex.get(index) ?? { arguments: "" };
    const id = firstString(call, ["id"]);
    if (id !== "") acc.id = id;
    const type = firstString(call, ["type"]);
    if (type !== "") acc.type = type;
    const fn = asRecord(call.function);
    if (fn) {
      const name = firstString(fn, ["name"]);
      if (name !== "") acc.name = name;
      acc.arguments += firstString(fn, ["arguments"]);
    }
    byIndex.set(index, acc);
  }
  store.set(choiceIndex, byIndex);
}

function finalizeToolCalls(byIndex?: Map<number, ToolCallAcc>): Array<Record<string, unknown>> {
  if (!byIndex) {
    return [];
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, acc]) => ({
    id: acc.id,
    type: acc.type ?? "function",
    function: { name: acc.name ?? "", arguments: acc.arguments },
  }));
}

function sseDataFrames(raw: string): string[] {
  const frames: string[] = [];
  for (const event of splitSseFrames(raw)) {
    const payload = sseEventData(event);
    if (payload === "" || payload === "[DONE]") {
      continue;
    }
    frames.push(payload);
  }
  return frames;
}

function operationFor(path: string, request: Record<string, unknown> | undefined): LlmOperation {
  const lower = path.toLowerCase();
  if (lower.includes("embedding")) return LLM_OPERATION_EMBEDDING;
  if (lower.includes("chat/completions") || lower.includes("/messages") || lower.includes("/responses")) return LLM_OPERATION_CHAT;
  if (lower.includes("completions") || lower.includes("/complete")) return LLM_OPERATION_COMPLETION;
  if (request) {
    if (request.messages !== undefined) return LLM_OPERATION_CHAT;
    if (request.input !== undefined) return LLM_OPERATION_EMBEDDING;
    if (request.prompt !== undefined) return LLM_OPERATION_COMPLETION;
  }
  return LLM_OPERATION_OTHER;
}

function usageOf(response: Record<string, unknown> | undefined): LlmUsage | undefined {
  const usage = asRecord(response?.usage);
  if (!usage) {
    return undefined;
  }
  const promptTokens = firstNumber(usage, ["prompt_tokens", "input_tokens"]);
  const completionTokens = firstNumber(usage, ["completion_tokens", "output_tokens"]);
  const totalTokens = firstNumber(usage, ["total_tokens"]);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function errorText(response: Record<string, unknown> | undefined, status: number): string {
  const err = response?.error;
  if (typeof err === "string" && err.trim() !== "") {
    return err;
  }
  const rec = asRecord(err);
  if (rec) {
    const message = firstString(rec, ["message"]);
    if (message !== "") return message;
  }
  if (status >= HTTP_ERROR_MIN) {
    return `upstream returned HTTP ${status}`;
  }
  return "";
}

function finishReasonOf(response: Record<string, unknown> | undefined): string {
  const choices = Array.isArray(response?.choices) ? response?.choices : [];
  const first = asRecord(choices?.[0]);
  return first ? firstString(first, ["finish_reason"]) : "";
}

function boolField(row: Record<string, unknown> | undefined, key: string): boolean {
  return row?.[key] === true;
}
