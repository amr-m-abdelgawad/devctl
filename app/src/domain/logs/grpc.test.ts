import { describe, expect, test } from "bun:test";
import { matchLog } from "./filter.ts";
import { isGrpcLog, RPC_SYSTEM_ATTR, RPC_SYSTEM_GRPC } from "./grpc.ts";
import { logRecord } from "./record.ts";

function line(message: string, extra: { service?: string; source?: string; attributes?: Record<string, string> } = {}) {
  return logRecord({
    timestamp: "2026-08-30T00:00:00.000Z",
    service: extra.service ?? "proxy",
    source: extra.source ?? "proxy",
    level: "INFO",
    message,
    attributes: extra.attributes,
    pid: 0,
    seq: 1,
  });
}

describe("isGrpcLog", () => {
  test("matches proxy gRPC hops and listener lines, including the rpc.system attribute", () => {
    const hop = line("grpc /pkg.Service/Poll route=temporal grpc-status=14 duration=1ms");
    const listen = line("grpc route temporal listening on 127.0.0.1:7233 → https://upstream");
    const tagged = line("worker started", {
      service: "worker",
      source: "stdout",
      attributes: { [RPC_SYSTEM_ATTR]: RPC_SYSTEM_GRPC },
    });
    expect(isGrpcLog(hop)).toBe(true);
    expect(isGrpcLog(listen)).toBe(true);
    expect(isGrpcLog(tagged)).toBe(true);
  });

  test("leaves HTTP proxy lines and service stdout that mentions grpc", () => {
    expect(isGrpcLog(line("GET /health route=api identity=user status=200 duration=2ms"))).toBe(false);
    expect(isGrpcLog(line("grpc client connected", { service: "worker", source: "stdout" }))).toBe(false);
    expect(isGrpcLog(line("POST /rpc route=api status=200 duration=3ms"))).toBe(false);
  });
});

describe("matchLog hideGrpc", () => {
  test("drops gRPC logs only when hideGrpc is set", () => {
    const grpc = line("grpc /pkg.Service/Poll route=temporal grpc-status=0");
    const http = line("GET /health route=api status=200 duration=1ms");
    expect(matchLog({}, grpc)).toBe(true);
    expect(matchLog({ hideGrpc: false }, grpc)).toBe(true);
    expect(matchLog({ hideGrpc: true }, grpc)).toBe(false);
    expect(matchLog({ hideGrpc: true }, http)).toBe(true);
  });
});
