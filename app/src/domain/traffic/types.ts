export const TRAFFIC_TRANSPORT_HTTP = "http";
export const TRAFFIC_TRANSPORT_GRPC = "grpc";

export type TrafficTransport = typeof TRAFFIC_TRANSPORT_HTTP | typeof TRAFFIC_TRANSPORT_GRPC;

export const DEFAULT_TRAFFIC_PAGE_SIZE = 100;
export const MAX_TRAFFIC_PAGE_SIZE = 500;
export const DEFAULT_TRAFFIC_STORE_CAP = 2_000;

export type TrafficPayload = {
  text?: string;
  data?: string;
  encoding?: "utf8" | "base64";
  omitted?: boolean;
  truncated?: boolean;
  contentType?: string;
};

export type TrafficCall = {
  seq: number;
  id: string;
  timestamp: string;
  method: string;
  path: string;
  route: string;
  transport: TrafficTransport;
  caller?: string;
  callerEmail?: string;
  status: number;
  grpcStatus?: string;
  durationMs?: number;
  request?: TrafficPayload;
  response?: TrafficPayload;
  attributes: Record<string, unknown>;
  requestId?: string;
  traceId?: string;
};

export type TrafficCallIngest = Omit<TrafficCall, "seq">;

export type TrafficCallFilter = {
  route?: string;
  caller?: string;
  method?: string;
  status?: string;
  search?: string;
  since?: string;
  until?: string;
  requestId?: string;
  traceId?: string;
  transport?: TrafficTransport;
};

export type TrafficCallPageRequest = {
  cursor?: string;
  limit?: number;
  /** When true, list rows omit payload bytes. */
  summary?: boolean;
};

export function summarizeTrafficCall(call: TrafficCall): TrafficCall {
  return {
    ...call,
    request: omitTrafficPayload(call.request),
    response: omitTrafficPayload(call.response),
  };
}

function omitTrafficPayload(payload: TrafficPayload | undefined): TrafficPayload | undefined {
  if (payload === undefined) {
    return undefined;
  }
  return { ...payload, text: undefined, data: undefined, omitted: true };
}

export type TrafficCallPage = {
  calls: TrafficCall[];
  nextCursor: string;
  hasNext: boolean;
};

export function clampTrafficPageSize(limit?: number): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return DEFAULT_TRAFFIC_PAGE_SIZE;
  }
  return Math.min(limit as number, MAX_TRAFFIC_PAGE_SIZE);
}

export function trafficIsError(call: Pick<TrafficCall, "status" | "grpcStatus">): boolean {
  if (call.status >= 400 || call.status === 0) {
    return true;
  }
  if (call.grpcStatus !== undefined && call.grpcStatus !== "" && call.grpcStatus !== "0") {
    return true;
  }
  return false;
}
