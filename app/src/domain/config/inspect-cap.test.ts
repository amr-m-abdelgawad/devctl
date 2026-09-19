import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LLM_CAPTURE_MAX_BYTES,
  DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES,
  cycleInspectCap,
  emptyRouteAuth,
  formatInspectCap,
  inspectCapBytes,
  llmCaptureMaxBytes,
  routeInspectMaxBytes,
} from "./types.ts";

const FOUR_MIB = 4 * DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES;
const EIGHT_MIB = 8 * DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES;
const SIXTEEN_MIB = 16 * DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES;

describe("inspect body caps", () => {
  test("0 falls through to the fallback, then 1 MiB", () => {
    expect(DEFAULT_LLM_CAPTURE_MAX_BYTES).toBe(DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES);
    expect(inspectCapBytes(0)).toBe(DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES);
    expect(inspectCapBytes(0, FOUR_MIB)).toBe(FOUR_MIB);
    expect(inspectCapBytes(EIGHT_MIB, FOUR_MIB)).toBe(EIGHT_MIB);
    expect(routeInspectMaxBytes({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      inspect: { enabled: true, max_bytes: 0 },
    }, FOUR_MIB)).toBe(FOUR_MIB);
    expect(llmCaptureMaxBytes({ prompts: true, max_bytes: 0, paths: [] }, EIGHT_MIB)).toBe(EIGHT_MIB);
  });

  test("cycles the Settings presets and wraps", () => {
    expect(formatInspectCap(DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES)).toBe("1 MiB");
    expect(cycleInspectCap(DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES, 1)).toBe(FOUR_MIB);
    expect(cycleInspectCap(SIXTEEN_MIB, 1)).toBe(DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES);
    expect(cycleInspectCap(DEFAULT_TRAFFIC_CAPTURE_MAX_BYTES, -1)).toBe(SIXTEEN_MIB);
    expect(cycleInspectCap(999, 1)).toBe(FOUR_MIB);
  });
});
