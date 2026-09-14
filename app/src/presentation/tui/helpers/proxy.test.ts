import { describe, expect, test } from "bun:test";
import { formatDurationMs } from "./format.ts";
import { proxyDurationView, proxyRequestPath, PROXY_DURATION_MISSING } from "./proxy.ts";

describe("proxy request duration", () => {
  test("formatDurationMs matches the web compact timing", () => {
    expect(formatDurationMs(12)).toBe("12ms");
    expect(formatDurationMs(999)).toBe("999ms");
    expect(formatDurationMs(1500)).toBe("1.50s");
    expect(formatDurationMs(-1)).toBe("0ms");
  });

  test("trace envelope is the request duration and proxy time is the hop", () => {
    expect(proxyDurationView({ durationMs: 12, traceDurationMs: 142 })).toEqual({
      request: "142ms",
      hop: "12ms",
    });
  });

  test("without a trace only the proxy hop is known", () => {
    expect(proxyDurationView({ durationMs: 74 })).toEqual({
      request: PROXY_DURATION_MISSING,
      hop: "74ms",
    });
  });

  test("failed requests keep the path and clip the error", () => {
    expect(proxyRequestPath({ path: "/health", error: "upstream timeout" }, 64)).toBe("/health — upstream timeout");
    expect(proxyRequestPath({ path: "/ok" }, 8)).toBe("/ok");
    expect(proxyRequestPath({ path: "/x", error: "abcdefghij" }, 4)).toBe("/x — abc…");
  });
});
