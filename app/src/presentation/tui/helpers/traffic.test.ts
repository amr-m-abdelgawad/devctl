import { describe, expect, test } from "bun:test";
import {
  clipTrafficJson,
  inspectEnabledCount,
  toggleTrafficBodyMode,
  trafficBodyModeHint,
  trafficPayloadView,
} from "./traffic.ts";

describe("traffic helpers", () => {
  test("toggles json and raw", () => {
    expect(toggleTrafficBodyMode("json")).toBe("raw");
    expect(toggleTrafficBodyMode("raw")).toBe("json");
    expect(trafficBodyModeHint("json")).toBe("raw");
  });

  test("renders omitted and json/raw payload views", () => {
    expect(trafficPayloadView({ omitted: true }, "json")).toContain("omitted");
    expect(trafficPayloadView({ text: '{ "a": 1 }', data: "YQ==" }, "json")).toBe('{ "a": 1 }');
    expect(trafficPayloadView({ text: '{ "a": 1 }', data: "YQ==" }, "raw")).toBe("YQ==");
    expect(clipTrafficJson("abcdef", 4)).toBe("abc…");
  });

  test("counts inspect-enabled routes", () => {
    expect(inspectEnabledCount([{ inspect: { enabled: true } }, { inspect: { enabled: false } }, {}])).toBe(1);
  });
});
