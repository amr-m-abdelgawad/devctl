// Port the HTTP proxy depends on to tee LLM completion bodies into the
// inspector without coupling the proxy adapter to the llm domain. The proxy
// calls `begin` per request; a returned recorder collects the (bounded)
// request/response bytes and is closed exactly once with `finish`. Everything
// here is best-effort: the proxy wraps these calls so a capture failure can
// never affect the proxied request.

export type LlmCaptureBegin = {
  routeName: string;
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  // Loopback TCP peer of the inbound socket, used to map the call back to a
  // managed service when the client did not send X-Devctl-Service.
  peer?: { address: string; port: number };
};

export type LlmCaptureFinish = {
  // Final HTTP status (502 when the upstream errored or the client
  // disconnected before a status was known).
  status: number;
  durationMs: number;
  requestId: string;
  traceId?: string;
  timestamp: string;
};

export type LlmCaptureRecorder = {
  // The per-direction byte cap for this capture. The proxy reads it to decide
  // whether a request with a known content-length is small enough to buffer
  // (rather than stream) before forwarding.
  readonly maxBytes: number;
  // Request bytes buffered by the proxy before dispatch, or `{ omitted: true }`
  // when the body was streamed instead of buffered (no content-length or over
  // the cap) so the mapper can mark it rather than lie about an empty body.
  setRequestBody(body: Buffer, opts?: { omitted?: boolean }): void;
  // The upstream response content-type — only known after fetch, and it selects
  // JSON vs SSE parsing at finish. Called once before the first appendResponse.
  setResponseContentType(contentType: string): void;
  // Copy a response chunk. Returns false once the byte cap is reached so the
  // proxy can stop copying (it keeps forwarding the full body regardless).
  appendResponse(chunk: Buffer): boolean;
  // Terminal: emit exactly one ingest. Must tolerate a half-empty recorder
  // (no request body, no response body, status 502) and never throw. May be
  // async when caller attribution started at begin (peer lookup) is still
  // settling.
  finish(meta: LlmCaptureFinish): void | Promise<void>;
};

export type LlmCaptureSink = {
  // Returns a recorder when the request is a capture target for a tagged route,
  // otherwise undefined — in which case the proxy runs its unchanged path.
  begin(input: LlmCaptureBegin): LlmCaptureRecorder | undefined;
};
