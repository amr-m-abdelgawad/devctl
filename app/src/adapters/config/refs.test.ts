import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyRouteAuth, emptyService } from "../../domain/config/types.ts";
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

  test("resolves service.url and .host to the direct loopback address by default", () => {
    const cfg = cfgWithApi([{ name: "http", value: 3000, auto: false }]);
    expect(resolveString("${services.api.url}", cfg, {})).toBe("http://127.0.0.1:3000");
    expect(resolveString("${services.api.url}", cfg, { api: { http: 4100 } })).toBe("http://127.0.0.1:4100");
    expect(resolveString("${services.api.host}", cfg, {})).toBe("127.0.0.1");
  });

  test("resolves service.url through the proxy when the service is exposed (hub mode)", () => {
    const cfg = cfgWithApi([{ name: "http", value: 3000, auto: false }]);
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port: 18080 };
    cfg.proxy.routes.push({
      name: "api",
      match: { host: "api.local", path: "" },
      upstream: { url: "", service: "api", port: "http" },
      auth: emptyRouteAuth(),
    });
    // The proxy address is stable even though the target's real port moved.
    expect(resolveString("${services.api.url}", cfg, { api: { http: 4100 } })).toBe("http://api.local:18080");
    expect(resolveString("${services.api.host}", cfg, {})).toBe("api.local");
  });

  test("service.url falls back to direct addressing when the proxy is disabled", () => {
    const cfg = cfgWithApi([{ name: "http", value: 3000, auto: false }]);
    // A route exists but the proxy is off — no hub, so resolve direct.
    cfg.proxy.routes.push({
      name: "api",
      match: { host: "api.local", path: "" },
      upstream: { url: "", service: "api", port: "http" },
      auth: emptyRouteAuth(),
    });
    expect(resolveString("${services.api.url}", cfg, {})).toBe("http://127.0.0.1:3000");
  });

  test("service.url is unresolvable for an auto port that has not been assigned yet", () => {
    const cfg = cfgWithApi([{ name: "http", value: 3000, auto: true }]);
    expect(() => resolveString("${services.api.url}", cfg, {})).toThrow(/unresolvable/);
    expect(resolveString("${services.api.url}", cfg, { api: { http: 4100 } })).toBe("http://127.0.0.1:4100");
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
