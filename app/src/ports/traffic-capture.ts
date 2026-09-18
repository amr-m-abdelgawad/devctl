// Port the HTTP and gRPC proxies depend on to tee request/response bodies into
// the traffic inspector without coupling those adapters to the traffic domain.
// Same begin/recorder/finish shape as LlmCaptureSink: best-effort, never fail
// the proxied hop.

export type TrafficCaptureBegin = {
  routeName: string;
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  transport: "http" | "grpc";
  peer?: { address: string; port: number };
};

export type TrafficCaptureFinish = {
  status: number;
  grpcStatus?: string;
  durationMs: number;
  requestId: string;
  traceId?: string;
  timestamp: string;
};

export type TrafficCaptureRecorder = {
  readonly maxBytes: number;
  setRequestBody(body: Buffer, opts?: { omitted?: boolean }): void;
  appendRequest(chunk: Buffer): boolean;
  setResponseContentType(contentType: string): void;
  appendResponse(chunk: Buffer): boolean;
  finish(meta: TrafficCaptureFinish): void | Promise<void>;
};

export type TrafficCaptureSink = {
  begin(input: TrafficCaptureBegin): TrafficCaptureRecorder | undefined;
};
