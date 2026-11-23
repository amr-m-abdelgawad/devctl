import { describe, expect, test } from "bun:test";
import { DevctlError, KindAuthentication } from "../../shared/errors.ts";
import {
  UPSTREAM_CONNECT_TIMEOUT_MS,
  UPSTREAM_PING_INTERVAL_MAX_MS,
  UPSTREAM_PING_INTERVAL_MS,
  UPSTREAM_PING_TIMEOUT_MS,
  isPingPenaltyGoaway,
  isUpstreamNetworkFailure,
  nextPingIntervalMs,
} from "./grpc-upstream.ts";

describe("grpc upstream liveness", () => {
  test("keepalive defaults are the operator-facing intervals", () => {
    expect(UPSTREAM_PING_INTERVAL_MS).toBe(30_000);
    expect(UPSTREAM_PING_TIMEOUT_MS).toBe(15_000);
    expect(UPSTREAM_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(UPSTREAM_PING_INTERVAL_MAX_MS).toBe(300_000);
  });

  test("a too_many_pings penalty doubles the interval and then stops at five minutes", () => {
    expect(nextPingIntervalMs(30_000)).toBe(60_000);
    expect(nextPingIntervalMs(240_000)).toBe(300_000);
    expect(nextPingIntervalMs(300_000)).toBe(300_000);
  });

  test("GOAWAY debug data names the ping penalty", () => {
    expect(isPingPenaltyGoaway(Buffer.from("too_many_pings"))).toBe(true);
    expect(isPingPenaltyGoaway(Buffer.from("going away"))).toBe(false);
    expect(isPingPenaltyGoaway(undefined)).toBe(false);
  });

  test("auth DNS loss is a network failure and a client cancel is not", () => {
    const dns = new Error("getaddrinfo EAI_AGAIN oauth2.googleapis.com") as NodeJS.ErrnoException;
    dns.code = "EAI_AGAIN";
    const wrapped = new DevctlError(KindAuthentication, "Google authentication failed", { cause: dns });
    expect(isUpstreamNetworkFailure(wrapped)).toBe(true);
    expect(isUpstreamNetworkFailure(new Error("The stream has been destroyed"))).toBe(false);
    expect(isUpstreamNetworkFailure(new Error("Stream closed with error code NGHTTP2_CANCEL"))).toBe(false);
    expect(isUpstreamNetworkFailure(new Error("upstream ping timeout"))).toBe(true);
  });
});
