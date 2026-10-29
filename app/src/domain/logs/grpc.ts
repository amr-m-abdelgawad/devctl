import { PROXY_LOG_SERVICE, PROXY_LOG_SOURCE } from "./correlate.ts";

/** OpenTelemetry semantic convention: this record is a gRPC call. */
export const RPC_SYSTEM_ATTR = "rpc.system";
export const RPC_SYSTEM_GRPC = "grpc";

// Proxy gRPC access and listener lines are `grpc <method-or-route> …`.
// A service line that merely mentions gRPC is left alone.
const GRPC_PROXY_LINE = /^grpc\s+\S/;

export type GrpcLogLike = {
  service?: string;
  source?: string;
  body?: unknown;
  raw?: string;
  attributes?: Readonly<Record<string, unknown>>;
};

export function isGrpcLog(record: GrpcLogLike): boolean {
  if (record.attributes?.[RPC_SYSTEM_ATTR] === RPC_SYSTEM_GRPC) {
    return true;
  }
  if (record.service !== PROXY_LOG_SERVICE || record.source !== PROXY_LOG_SOURCE) {
    return false;
  }
  return GRPC_PROXY_LINE.test(firstLine(grpcLogText(record)));
}

function grpcLogText(record: GrpcLogLike): string {
  if (typeof record.body === "string" && record.body !== "") {
    return record.body;
  }
  return record.raw ?? "";
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}
