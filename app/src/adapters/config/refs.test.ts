import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyRouteAuth, emptyService } from "../../domain/config/types.ts";
import { findRefs, healthRefResolvable, refResolvable, resolveEnvMap, resolveHealthConfig, resolveString } from "./refs.ts";
import { emptyHealth } from "../../domain/config/types.ts";

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

  test("resolves ${identity.user} to the detected developer email, empty when absent", () => {
    const cfg = defaultConfig();
    expect(resolveString("${identity.user}", cfg, {}, "dev@example.com")).toBe("dev@example.com");
    expect(resolveString("LOCAL_USER_EMAIL=${identity.user}", cfg, {}, "dev@example.com")).toBe("LOCAL_USER_EMAIL=dev@example.com");
    expect(resolveString("${identity.user}", cfg, {})).toBe("");
    expect(resolveEnvMap({ LOCAL_USER_EMAIL: "${identity.user}" }, cfg, {}, "dev@example.com")).toEqual({ LOCAL_USER_EMAIL: "dev@example.com" });
  });

  test("rejects an unknown identity reference", () => {
    const cfg = defaultConfig();
    expect(() => resolveString("${identity.project}", cfg, {}, "x")).toThrow(/unsupported/);
    expect(refResolvable("identity.user", cfg)).toBe(true);
    expect(refResolvable("identity.project", cfg)).toBe(false);
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
    expect(refResolvable("http.login.token", cfg)).toBe(false);
  });

  test("resolves ${http.name.output} from a snapshot map", () => {
    const cfg = defaultConfig();
    cfg.http.login = {
      request: { method: "POST", url: "https://idp.example/token", headers: {}, body: "", form: {}, auth: emptyRouteAuth(), timeout_seconds: 0 },
      outputs: { token: "access_token" },
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    expect(refResolvable("http.login.token", cfg)).toBe(true);
    expect(refResolvable("http.login.body", cfg)).toBe(true);
    expect(refResolvable("http.login.missing", cfg)).toBe(false);
    expect(resolveString("t=${http.login.token}", cfg, {}, "", { http: { login: { token: "abc" } } })).toBe("t=abc");
  });

  test("recipe strings expand process env and ${token}", () => {
    const cfg = defaultConfig();
    expect(resolveString("Basic ${APIGEE_BASIC}", cfg, {}, "", { processEnv: { APIGEE_BASIC: "abc123" } })).toBe("Basic abc123");
    expect(resolveString("sub=${token}", cfg, {}, "", { token: "id-token" })).toBe("sub=id-token");
    expect(refResolvable("env.HOME", cfg, { allowProcessEnv: true })).toBe(true);
    expect(refResolvable("HOME", cfg, { allowProcessEnv: true })).toBe(true);
    expect(refResolvable("token", cfg, { allowToken: true })).toBe(true);
    expect(refResolvable("token", cfg)).toBe(false);
  });

  test("resolveHealthConfig expands health.url and health.address from assigned ports", () => {
    const cfg = cfgWithApi([{ name: "http", value: 0, auto: true }, { name: "grpc", value: 0, auto: true }]);
    const http = { ...emptyHealth(), type: "http", url: "http://127.0.0.1:${services.api.ports.http}/health" };
    expect(resolveHealthConfig(http, cfg, "api", { http: 41234, grpc: 41235 }).url).toBe("http://127.0.0.1:41234/health");
    const grpc = { ...emptyHealth(), type: "grpc", address: "127.0.0.1:${services.api.ports.grpc}" };
    expect(resolveHealthConfig(grpc, cfg, "api", { http: 41234, grpc: 41235 }).address).toBe("127.0.0.1:41235");
  });

  test("resolveHealthConfig reads other services from running and fixed ports", () => {
    const cfg = cfgWithApi([{ name: "http", value: 0, auto: true }]);
    cfg.services.db = { ...emptyService(), ports: [{ name: "pg", value: 5432, auto: false }] };
    const health = { ...emptyHealth(), type: "tcp", address: "127.0.0.1:${services.db.ports.pg}" };
    expect(resolveHealthConfig(health, cfg, "worker", {}).address).toBe("127.0.0.1:5432");
    const url = { ...emptyHealth(), type: "http", url: "http://127.0.0.1:${services.api.port}/" };
    expect(resolveHealthConfig(url, cfg, "worker", {}, new Map([["api", { http: 40001 }]])).url).toBe("http://127.0.0.1:40001/");
  });

  test("resolveHealthConfig leaves template-free config untouched", () => {
    const health = { ...emptyHealth(), type: "http", url: "http://127.0.0.1:3000/" };
    expect(resolveHealthConfig(health, defaultConfig(), "api", {})).toBe(health);
  });

  test("resolveHealthConfig names the field when a reference cannot expand", () => {
    const cfg = cfgWithApi([{ name: "http", value: 0, auto: true }]);
    const health = { ...emptyHealth(), type: "http", url: "http://127.0.0.1:${services.api.ports.http}/" };
    expect(() => resolveHealthConfig(health, cfg, "worker", {})).toThrow(/^health\.url: unresolvable reference/);
  });

  test("resolveHealthConfig picks .port in declared order, http first", () => {
    const cfg = cfgWithApi([{ name: "grpc", value: 0, auto: true }, { name: "metrics", value: 9100, auto: false }]);
    const health = { ...emptyHealth(), type: "tcp", address: "127.0.0.1:${services.api.port}" };
    expect(resolveHealthConfig(health, cfg, "api", { grpc: 41000, metrics: 9100 }).address).toBe("127.0.0.1:41000");
    expect(resolveHealthConfig(health, cfg, "worker", {}, new Map([["api", { grpc: 41000 }]])).address).toBe("127.0.0.1:41000");
    const withHttp = cfgWithApi([{ name: "grpc", value: 0, auto: true }, { name: "http", value: 0, auto: true }]);
    expect(resolveHealthConfig(health, withHttp, "api", { grpc: 41000, http: 41001 }).address).toBe("127.0.0.1:41001");
  });

  test("healthRefResolvable accepts exactly the forms the resolver expands", () => {
    const cfg = cfgWithApi([{ name: "http", value: 0, auto: true }, { name: "metrics", value: 9100, auto: false }]);
    cfg.services.bare = emptyService();
    for (const ref of ["services.api.port", "services.api.host", "services.api.url", "services.api.ports.http", "services.api.ports.1", "services.bare.host"]) {
      expect(healthRefResolvable(ref, cfg), ref).toBe(true);
    }
    for (const ref of [
      "services.api.bogus",
      "services.api.ports.admin",
      "services.api.ports.0",
      "services.api.ports.7",
      "services.api.ports.http.extra",
      "services.api.port.http",
      "services.bare.port",
      "services.bare.url",
      "services.nope.port",
      "env.API_PORT",
      "identity.user",
    ]) {
      expect(healthRefResolvable(ref, cfg), ref).toBe(false);
    }
  });
});
