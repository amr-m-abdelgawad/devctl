import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../../domain/config/types.ts";
import { findRefs, refResolvable, resolveEnvMap, resolveString } from "./refs.ts";

function cfgWithApi(ports: { name: string; value: number; auto: boolean }[]) {
  const cfg = defaultConfig();
  cfg.services.api = { ...emptyService(), ports };
  return cfg;
}

describe("config refs", () => {
  test("leaves strings without interpolations alone", () => {
    const cfg = defaultConfig();
    expect(resolveString("plain", cfg, {})).toBe("plain");
  });

  test("resolves service.port from assigned http, then first assigned, then static config", () => {
    const cfg = cfgWithApi([{ name: "http", value: 3000, auto: false }]);
    expect(resolveString("p=${services.api.port}", cfg, { api: { http: 4000 } })).toBe("p=4000");
    expect(resolveString("${services.api.port}", cfg, { api: { grpc: 5000 } })).toBe("5000");
    expect(resolveString("${services.api.port}", cfg, {})).toBe("3000");
  });

  test("resolves named and indexed ports", () => {
    const cfg = cfgWithApi([
      { name: "http", value: 3000, auto: false },
      { name: "grpc", value: 50051, auto: false },
    ]);
    expect(resolveString("${services.api.ports.grpc}", cfg, {})).toBe("50051");
    expect(resolveString("${services.api.ports.1}", cfg, {})).toBe("50051");
    expect(resolveString("${services.api.ports.grpc}", cfg, { api: { grpc: 9 } })).toBe("9");
  });

  test("rejects unclosed, unknown, and unresolvable refs", () => {
    const cfg = defaultConfig();
    expect(() => resolveString("x=${oops", cfg, {})).toThrow(/unclosed/);
    expect(() => resolveString("${env.HOME}", cfg, {})).toThrow(/unsupported/);
    expect(() => resolveString("${services.missing.port}", cfg, {})).toThrow(/unknown service/);
    const api = cfgWithApi([{ name: "http", value: 3000, auto: true }]);
    expect(() => resolveString("${services.api.ports}", api, {})).toThrow(/missing port name/);
    expect(() => resolveString("${services.api.ports.http}", api, {})).toThrow(/unresolvable/);
  });

  test("resolveEnvMap interpolates each value", () => {
    const cfg = cfgWithApi([{ name: "http", value: 3000, auto: false }]);
    expect(resolveEnvMap({ URL: "http://127.0.0.1:${services.api.port}" }, cfg, {})).toEqual({
      URL: "http://127.0.0.1:3000",
    });
  });

  test("findRefs and refResolvable inspect interpolations without evaluating them", () => {
    const cfg = cfgWithApi([{ name: "http", value: 3000, auto: false }]);
    expect(findRefs("a=${services.api.port} b=${oops")).toEqual(["services.api.port"]);
    expect(findRefs("plain")).toEqual([]);
    expect(refResolvable("x", cfg)).toBe(false);
    expect(refResolvable("env.HOME", cfg)).toBe(false);
    expect(refResolvable("services.missing.port", cfg)).toBe(false);
    expect(refResolvable("services.api.port", cfg)).toBe(true);
    expect(refResolvable("services.api.ports.http", cfg)).toBe(true);
    expect(refResolvable("services.api.ports.0", cfg)).toBe(true);
    expect(refResolvable("services.api.ports.nope", cfg)).toBe(false);
    expect(refResolvable("services.api.workdir", cfg)).toBe(true);
  });
});
