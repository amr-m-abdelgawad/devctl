import { describe, expect, test } from "bun:test";
import { activeInspectId, hrefFor, logsHref, parseHash } from "./hash.ts";

describe("web hash", () => {
  test("deep-links to a service and scopes its log view without losing encoded names", () => {
    expect(hrefFor("services", "billing api")).toBe("#/services/billing%20api");
    expect(parseHash("#/services/billing%20api")).toEqual({ name: "services", serviceId: "billing api" });
    expect(parseHash("#/logs?service=billing%20api")).toEqual({ name: "logs", logService: "billing api" });
    expect(logsHref("telemetry", 42)).toBe("#/logs?service=telemetry&seq=42");
    expect(parseHash("#/logs?service=telemetry&seq=42")).toEqual({ name: "logs", logService: "telemetry", logSeq: 42 });
    expect(parseHash("#/logs?seq=nope")).toEqual({ name: "logs" });
    for (const name of ["workspace", "config", "proxy"] as const) expect(parseHash(hrefFor(name))).toEqual({ name });
  });
  test("parses the settings hash", () => {
    expect(parseHash("#/settings")).toEqual({ name: "settings" });
    expect(hrefFor("settings")).toBe("#/settings");
  });

  test("parses traffic list and detail hashes", () => {
    expect(parseHash("#/traffic")).toEqual({ name: "traffic" });
    expect(parseHash("#/traffic/req-1")).toEqual({ name: "traffic", trafficId: "req-1" });
    expect(hrefFor("traffic")).toBe("#/traffic");
    expect(hrefFor("traffic", "req-1")).toBe("#/traffic/req-1");
  });

  test("keeps a pinned inspect id when a newer row arrives", () => {
    expect(activeInspectId(undefined, "new")).toBe("new");
    expect(activeInspectId("old", "new")).toBe("old");
    expect(activeInspectId(undefined, undefined)).toBeUndefined();
  });

  test("parses doctor and identity hashes", () => {
    expect(parseHash("#/doctor")).toEqual({ name: "doctor" });
    expect(parseHash("#/identity")).toEqual({ name: "identity" });
    expect(hrefFor("doctor")).toBe("#/doctor");
    expect(hrefFor("identity")).toBe("#/identity");
  });
});
