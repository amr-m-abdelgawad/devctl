import {
  routeInspectDecoder,
  routeInspectEnabled,
  routeInspectMaxBytes,
  type DevctlConfig,
  type RouteConfig,
} from "../../domain/config/types.ts";
import { callerFromHeaders, normalizeLlmCaller } from "../../domain/llm/caller.ts";
import { isLoopbackPeer } from "../../domain/net/hosts.ts";
import {
  grpcTrafficPayload,
  httpTrafficPayload,
  splitGrpcFrames,
  TRAFFIC_TRANSPORT_GRPC,
  TRAFFIC_TRANSPORT_HTTP,
  type GrpcCapturedFrame,
  type TrafficCallIngest,
  type TrafficPayload,
} from "../../domain/traffic/traffic.ts";
import type { TrafficCallStore } from "../../ports/traffic-call-store.ts";
import type {
  TrafficCaptureBegin,
  TrafficCaptureFinish,
  TrafficCaptureRecorder,
  TrafficCaptureSink,
} from "../../ports/traffic-capture.ts";
import type { TrafficDecoder } from "../plugins/registry.ts";

export type TrafficCallerLookup = (peer: { address: string; port: number }) => Promise<string | undefined>;

export type TrafficCaptureSinkDeps = {
  cfg: () => DevctlConfig;
  store: TrafficCallStore;
  log?: (message: string) => void;
  lookupCaller?: TrafficCallerLookup;
  decoders?: () => readonly TrafficDecoder[];
};

export class ProxyTrafficSink implements TrafficCaptureSink {
  private readonly deps: TrafficCaptureSinkDeps;

  constructor(deps: TrafficCaptureSinkDeps) {
    this.deps = deps;
  }

  begin(input: TrafficCaptureBegin): TrafficCaptureRecorder | undefined {
    const route = matchingInspectRoute(this.deps.cfg(), input.routeName);
    if (!route) {
      return undefined;
    }
    return new TrafficRecorder(input, route, this.deps);
  }
}

class TrafficRecorder implements TrafficCaptureRecorder {
  readonly maxBytes: number;
  private requestBody?: Buffer;
  private requestOmitted = false;
  private requestTruncated = false;
  private requestLen = 0;
  private responseContentType = "";
  private readonly responseChunks: Buffer[] = [];
  private responseLen = 0;
  private responseTruncated = false;
  private done = false;
  private readonly headerCaller: string | undefined;
  private readonly peerCaller: Promise<string | undefined>;

  private readonly decoderName: string;

  constructor(
    private readonly begin: TrafficCaptureBegin,
    route: RouteConfig,
    private readonly deps: TrafficCaptureSinkDeps,
  ) {
    this.maxBytes = routeInspectMaxBytes(route);
    this.decoderName = routeInspectDecoder(route);
    this.headerCaller = callerFromHeaders(begin.requestHeaders);
    this.peerCaller = this.headerCaller === undefined ? lookupPeerCaller(begin, deps) : Promise.resolve(undefined);
  }

  setRequestBody(body: Buffer, opts?: { omitted?: boolean }): void {
    if (opts?.omitted) {
      this.requestOmitted = true;
      return;
    }
    if (body.length > this.maxBytes) {
      this.requestBody = body.subarray(0, this.maxBytes);
      this.requestTruncated = true;
      this.requestLen = this.maxBytes;
      return;
    }
    this.requestBody = body;
    this.requestLen = body.length;
  }

  appendRequest(chunk: Buffer): boolean {
    if (this.requestOmitted) {
      return false;
    }
    if (this.requestLen >= this.maxBytes) {
      this.requestTruncated = true;
      return false;
    }
    const remaining = this.maxBytes - this.requestLen;
    const take = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.requestBody = this.requestBody ? Buffer.concat([this.requestBody, take]) : Buffer.from(take);
    this.requestLen += take.length;
    if (chunk.length > remaining) {
      this.requestTruncated = true;
      return false;
    }
    return true;
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

  finish(meta: TrafficCaptureFinish): void | Promise<void> {
    if (this.done) {
      return;
    }
    this.done = true;
    return this.persist(meta);
  }

  private async persist(meta: TrafficCaptureFinish): Promise<void> {
    try {
      const grpc = this.begin.transport === TRAFFIC_TRANSPORT_GRPC;
      const requestBuf = this.requestBody;
      const responseBuf = this.responseChunks.length > 0 ? Buffer.concat(this.responseChunks) : undefined;
      const ingest: TrafficCallIngest = {
        id: meta.requestId,
        timestamp: meta.timestamp,
        method: this.begin.method,
        path: this.begin.path,
        route: this.begin.routeName,
        transport: grpc ? TRAFFIC_TRANSPORT_GRPC : TRAFFIC_TRANSPORT_HTTP,
        caller: await this.resolveCaller(),
        status: meta.status,
        grpcStatus: meta.grpcStatus,
        durationMs: meta.durationMs,
        request: grpc
          ? this.grpcPayload(requestBuf, {
              omitted: this.requestOmitted,
              truncated: this.requestTruncated,
              side: "request",
              contentType: contentTypeOf(this.begin.requestHeaders),
            })
          : httpTrafficPayload(requestBuf, contentTypeOf(this.begin.requestHeaders), {
              omitted: this.requestOmitted,
              truncated: this.requestTruncated,
            }),
        response: grpc
          ? this.grpcPayload(responseBuf, {
              truncated: this.responseTruncated,
              side: "response",
              contentType: this.responseContentType,
            })
          : httpTrafficPayload(responseBuf, this.responseContentType, { truncated: this.responseTruncated }),
        attributes: {
          capture: "proxy",
          route: this.begin.routeName,
          transport: grpc ? TRAFFIC_TRANSPORT_GRPC : TRAFFIC_TRANSPORT_HTTP,
        },
        requestId: meta.requestId,
        traceId: meta.traceId,
      };
      this.deps.store.upsert([ingest]);
    } catch (err) {
      this.deps.log?.(`traffic capture ${this.begin.routeName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async resolveCaller(): Promise<string | undefined> {
    if (this.headerCaller !== undefined) {
      return this.headerCaller;
    }
    return this.peerCaller;
  }

  private grpcPayload(
    body: Buffer | undefined,
    opts: { omitted?: boolean; truncated: boolean; side: "request" | "response"; contentType: string },
  ): TrafficPayload {
    if (opts.omitted || !body || body.length === 0) {
      return grpcTrafficPayload(body, { omitted: opts.omitted, truncated: opts.truncated });
    }
    const split = splitGrpcFrames(body);
    const truncated = opts.truncated || split.truncated;
    const messages = inflateGrpcMessages(split.frames);
    if (messages === undefined) {
      return grpcTrafficPayload(body, { truncated, decode: false });
    }
    return grpcTrafficPayload(body, {
      truncated,
      contentType: opts.contentType,
      messages,
      decoded: invokeTrafficDecoder(this.deps.decoders?.() ?? [], this.decoderName, this.begin.path, opts.side, messages),
    });
  }
}

function inflateGrpcMessages(frames: GrpcCapturedFrame[]): Uint8Array[] | undefined {
  const messages: Uint8Array[] = [];
  for (const frame of frames) {
    if (!frame.compressed) {
      messages.push(frame.message);
      continue;
    }
    try {
      const packed = new Uint8Array(frame.message);
      messages.push(new Uint8Array(Bun.gunzipSync(packed)));
    } catch {
      return undefined;
    }
  }
  return messages;
}

function invokeTrafficDecoder(
  decoders: readonly TrafficDecoder[],
  name: string,
  path: string,
  side: "request" | "response",
  messages: Uint8Array[],
): unknown | undefined {
  if (name === "") {
    return undefined;
  }
  const decoder = decoders.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!decoder) {
    return undefined;
  }
  try {
    return decoder.decode({ path, side, messages });
  } catch {
    return undefined;
  }
}

function matchingInspectRoute(cfg: DevctlConfig, routeName: string): RouteConfig | undefined {
  if (!cfg.proxy.enabled) {
    return undefined;
  }
  const route = cfg.proxy.routes.find((item) => item.name === routeName);
  if (!route || !routeInspectEnabled(route)) {
    return undefined;
  }
  if ((route.upstream.recipe ?? "").trim() !== "") {
    return undefined;
  }
  return route;
}

async function lookupPeerCaller(begin: TrafficCaptureBegin, deps: TrafficCaptureSinkDeps): Promise<string | undefined> {
  const peer = begin.peer;
  const lookup = deps.lookupCaller;
  if (!peer || !lookup || !isLoopbackPeer(peer.address)) {
    return undefined;
  }
  try {
    const found = await lookup(peer);
    return found === undefined ? undefined : normalizeLlmCaller(found);
  } catch (err) {
    deps.log?.(`traffic caller lookup: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function contentTypeOf(headers: Record<string, string>): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") {
      return value;
    }
  }
  return "";
}
