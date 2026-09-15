import {
  LLM_SOURCE_TYPE_PROXY,
  llmCaptureMaxBytes,
  type DevctlConfig,
  type LlmSourceConfig,
} from "../../domain/config/types.ts";
import { stripLlmBodies } from "../../domain/llm/llm.ts";
import type { LlmCallStore } from "../../ports/llm-call-store.ts";
import type {
  LlmCaptureBegin,
  LlmCaptureFinish,
  LlmCaptureRecorder,
  LlmCaptureSink,
} from "../../ports/llm-capture.ts";
import { mapProxyCapture } from "./proxy-capture-map.ts";

// Paths whose POST traffic is treated as an OpenAI-compatible completion.
// Matched as substrings so any mount prefix (e.g. /llm/v1/chat/completions)
// still resolves. `/completions` also covers `/chat/completions`. Only formats
// the mapper/SSE reassembler understands (OpenAI chat + text completions and
// embeddings) are listed; Anthropic `/messages` and the OpenAI Responses API
// use different request/stream shapes and are intentionally excluded so we
// never store an empty or mis-parsed body.
const COMPLETION_PATH_HINTS = ["/completions", "/embeddings"];

export type ProxyCaptureSinkDeps = {
  cfg: () => DevctlConfig;
  store: LlmCallStore;
  log?: (message: string) => void;
};

export class ProxyCaptureSink implements LlmCaptureSink {
  private readonly deps: ProxyCaptureSinkDeps;

  constructor(deps: ProxyCaptureSinkDeps) {
    this.deps = deps;
  }

  begin(input: LlmCaptureBegin): LlmCaptureRecorder | undefined {
    if (input.method.toUpperCase() !== "POST") {
      return undefined;
    }
    if (!contentTypeIsJson(input.requestHeaders)) {
      return undefined;
    }
    if (!isCompletionPath(input.path)) {
      return undefined;
    }
    const source = this.matchingSource(input.routeName);
    if (!source) {
      return undefined;
    }
    return new Recorder(input, source, this.deps);
  }

  private matchingSource(routeName: string): LlmSourceConfig | undefined {
    const cfg = this.deps.cfg();
    if (!cfg.llm.enabled) {
      return undefined;
    }
    return cfg.llm.sources.find(
      (source) => source.type.trim().toLowerCase() === LLM_SOURCE_TYPE_PROXY && source.via.route === routeName,
    );
  }
}

class Recorder implements LlmCaptureRecorder {
  readonly maxBytes: number;
  private requestBody?: Buffer;
  private requestOmitted = false;
  private responseContentType = "";
  private readonly responseChunks: Buffer[] = [];
  private responseLen = 0;
  private responseTruncated = false;
  private done = false;

  constructor(
    private readonly begin: LlmCaptureBegin,
    private readonly source: LlmSourceConfig,
    private readonly deps: ProxyCaptureSinkDeps,
  ) {
    this.maxBytes = llmCaptureMaxBytes(source.capture);
  }

  setRequestBody(body: Buffer, opts?: { omitted?: boolean }): void {
    if (opts?.omitted) {
      this.requestOmitted = true;
      return;
    }
    // The proxy only hands over a buffered request within the cap; guard anyway.
    this.requestBody = body.length > this.maxBytes ? body.subarray(0, this.maxBytes) : body;
  }

  setResponseContentType(contentType: string): void {
    this.responseContentType = contentType;
  }

  appendResponse(chunk: Buffer): boolean {
    if (this.responseLen >= this.maxBytes) {
      this.responseTruncated = true;
      return false;
    }
    const remaining = this.maxBytes - this.responseLen;
    if (chunk.length > remaining) {
      this.responseChunks.push(chunk.subarray(0, remaining));
      this.responseLen = this.maxBytes;
      this.responseTruncated = true;
      return false;
    }
    this.responseChunks.push(chunk);
    this.responseLen += chunk.length;
    return true;
  }

  finish(meta: LlmCaptureFinish): void {
    if (this.done) {
      return;
    }
    this.done = true;
    try {
      const ingest = mapProxyCapture({
        source: this.source.name,
        route: this.begin.routeName,
        method: this.begin.method,
        path: this.begin.path,
        status: meta.status,
        durationMs: meta.durationMs,
        requestId: meta.requestId,
        traceId: meta.traceId,
        timestamp: meta.timestamp,
        requestBody: this.requestBody?.toString("utf8"),
        requestOmitted: this.requestOmitted,
        responseBody: this.responseChunks.length > 0 ? Buffer.concat(this.responseChunks).toString("utf8") : undefined,
        responseTruncated: this.responseTruncated,
        responseContentType: this.responseContentType,
      });
      this.deps.store.upsert([this.source.capture.prompts ? ingest : stripLlmBodies(ingest)]);
    } catch (err) {
      this.deps.log?.(`llm proxy capture ${this.source.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isCompletionPath(path: string): boolean {
  const lower = path.toLowerCase();
  return COMPLETION_PATH_HINTS.some((hint) => lower.includes(hint));
}

function contentTypeIsJson(headers: Record<string, string>): boolean {
  return headerValue(headers, "content-type").toLowerCase().includes("application/json");
}

function headerValue(headers: Record<string, string>, name: string): string {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return "";
}
