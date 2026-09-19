import {
  LLM_SOURCE_TYPE_PROXY,
  llmCaptureMaxBytes,
  llmViaRoutes,
  type DevctlConfig,
  type LlmSourceConfig,
} from "../../domain/config/types.ts";
import {
  callerFromCompletionRequest,
  callerFromHeaders,
  headerValueIgnoreCase,
  normalizeLlmCaller,
} from "../../domain/llm/caller.ts";
import { stripLlmBodies } from "../../domain/llm/llm.ts";
import { isLoopbackPeer } from "../../domain/net/hosts.ts";
import type { LlmCallStore } from "../../ports/llm-call-store.ts";
import type {
  LlmCaptureBegin,
  LlmCaptureFinish,
  LlmCaptureRecorder,
  LlmCaptureSink,
} from "../../ports/llm-capture.ts";
import { parseJsonish } from "./json.ts";
import { mapProxyCapture } from "./proxy-capture-map.ts";

// Paths whose POST traffic is treated as an OpenAI-compatible completion.
// Matched as substrings so any mount prefix (e.g. /llm/v1/chat/completions)
// still resolves. `/completions` also covers `/chat/completions`. Only formats
// the mapper/SSE reassembler understands (OpenAI chat + text completions and
// embeddings) are listed by default; Anthropic `/messages` and the OpenAI
// Responses API use different request/stream shapes and are excluded unless
// named in `capture.paths` (those extra paths store raw bodies instead).
const COMPLETION_PATH_HINTS = ["/completions", "/embeddings"];

export type LlmCallerLookup = (peer: { address: string; port: number }) => Promise<string | undefined>;

export type ProxyCaptureSinkDeps = {
  cfg: () => DevctlConfig;
  store: LlmCallStore;
  log?: (message: string) => void;
  lookupCaller?: LlmCallerLookup;
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
    const source = this.matchingSource(input.routeName);
    if (!source) {
      return undefined;
    }
    const openai = isCompletionPath(input.path);
    if (!openai && !matchesConfiguredPaths(input.path, source.capture.paths)) {
      return undefined;
    }
    return new Recorder(input, source, this.deps, !openai);
  }

  private matchingSource(routeName: string): LlmSourceConfig | undefined {
    const cfg = this.deps.cfg();
    if (!cfg.llm.enabled) {
      return undefined;
    }
    return cfg.llm.sources.find(
      (source) => source.type.trim().toLowerCase() === LLM_SOURCE_TYPE_PROXY && llmViaRoutes(source.via).includes(routeName),
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
  private readonly headerCaller: string | undefined;
  private readonly peerCaller: Promise<string | undefined>;

  constructor(
    private readonly begin: LlmCaptureBegin,
    private readonly source: LlmSourceConfig,
    private readonly deps: ProxyCaptureSinkDeps,
    private readonly raw: boolean,
  ) {
    this.maxBytes = llmCaptureMaxBytes(source.capture);
    // Resolve the peer while the inbound socket is still ESTABLISHED. Waiting
    // until finish() races the client close and leaves caller empty so the UI
    // only has the proxy source name (apigee-llm).
    this.headerCaller = callerFromHeaders(begin.requestHeaders);
    this.peerCaller = this.headerCaller === undefined ? lookupPeerCaller(begin, deps) : Promise.resolve(undefined);
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

  finish(meta: LlmCaptureFinish): void | Promise<void> {
    if (this.done) {
      return;
    }
    this.done = true;
    return this.persist(meta);
  }

  private async persist(meta: LlmCaptureFinish): Promise<void> {
    try {
      const requestBody = this.requestBody?.toString("utf8");
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
        requestBody,
        requestOmitted: this.requestOmitted,
        responseBody: this.responseChunks.length > 0 ? Buffer.concat(this.responseChunks).toString("utf8") : undefined,
        responseTruncated: this.responseTruncated,
        responseContentType: this.responseContentType,
        caller: await this.resolveCaller(requestBody),
        raw: this.raw,
      });
      this.deps.store.upsert([this.source.capture.prompts ? ingest : stripLlmBodies(ingest)]);
    } catch (err) {
      this.deps.log?.(`llm proxy capture ${this.source.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async resolveCaller(requestBody: string | undefined): Promise<string | undefined> {
    if (this.headerCaller !== undefined) {
      return this.headerCaller;
    }
    const fromPeer = await this.peerCaller;
    if (fromPeer !== undefined) {
      return fromPeer;
    }
    return callerFromCompletionRequest(parseJsonish(requestBody));
  }
}

async function lookupPeerCaller(begin: LlmCaptureBegin, deps: ProxyCaptureSinkDeps): Promise<string | undefined> {
  const peer = begin.peer;
  const lookup = deps.lookupCaller;
  if (!peer || !lookup || !isLoopbackPeer(peer.address)) {
    return undefined;
  }
  return lookupCallerSafe(lookup, peer, deps);
}

async function lookupCallerSafe(
  lookup: LlmCallerLookup,
  peer: { address: string; port: number },
  deps: ProxyCaptureSinkDeps,
): Promise<string | undefined> {
  try {
    const found = await lookup(peer);
    return found === undefined ? undefined : normalizeLlmCaller(found);
  } catch (err) {
    deps.log?.(`llm caller lookup: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function isCompletionPath(path: string): boolean {
  const lower = requestPathname(path);
  return COMPLETION_PATH_HINTS.some((hint) => lower.includes(hint));
}

function matchesConfiguredPaths(path: string, extraPaths: string[]): boolean {
  const lower = requestPathname(path);
  return extraPaths.some((hint) => {
    const needle = hint.trim().toLowerCase();
    return needle !== "" && lower.includes(needle);
  });
}

function requestPathname(path: string): string {
  const query = path.indexOf("?");
  const hash = path.indexOf("#");
  let end = path.length;
  if (query !== -1) {
    end = Math.min(end, query);
  }
  if (hash !== -1) {
    end = Math.min(end, hash);
  }
  return path.slice(0, end).toLowerCase();
}

function contentTypeIsJson(headers: Record<string, string>): boolean {
  return headerValueIgnoreCase(headers, "content-type").toLowerCase().includes("application/json");
}
