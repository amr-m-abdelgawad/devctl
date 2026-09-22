import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyService, emptyRouteAuth, emptyProfile, emptyLlmSource, defaultConfig, type RouteAuthConfig, type LlmSourceConfig } from "../../domain/config/types.ts";
import { decodeRoute } from "./decode.ts";
import { unresolvedInspectDecoders, validate, isValidationWarning } from "./validate.ts";

function withService(name: string, command: string[] = ["echo", "ok"]): ReturnType<typeof defaultConfig> {
  const cfg = defaultConfig();
  const svc = emptyService();
  svc.command = { args: command, shell: false };
  cfg.services[name] = svc;
  return cfg;
}

function iapUserAuth(overrides: Partial<RouteAuthConfig> = {}): RouteAuthConfig {
  return {
    ...emptyRouteAuth(),
    type: "iap",
    identity: { type: "user", service_account: "" },
    audience: "/projects/1/iap",
    ...overrides,
  };
}

describe("config validate", () => {
  test("enabled proxy with port 0 is an error", () => {
    const cfg = withService("api");
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port: 0 };
    expect(validate(cfg)).toContain("proxy.listen.port is required when proxy.enabled is true");
  });

  test("rejects dependency cycles", () => {
    const cfg = withService("a");
    cfg.services.b = { ...emptyService(), command: { args: ["echo"], shell: false }, dependencies: ["a"] };
    cfg.services.a!.dependencies = ["b"];
    expect(validate(cfg).some((issue) => issue.includes("dependency cycle"))).toBe(true);
  });

  test("rejects duplicate ports", () => {
    const cfg = withService("a");
    cfg.services.a!.ports = [{ name: "http", value: 8000, auto: false }];
    cfg.services.b = { ...emptyService(), command: { args: ["echo"], shell: false }, ports: [{ name: "http", value: 8000, auto: false }] };
    expect(validate(cfg).some((issue) => issue.includes("duplicate port"))).toBe(true);
  });

  test("accepts a service-reference upstream naming a real service and port", () => {
    const cfg = withService("api");
    cfg.services.api!.ports = [{ name: "http", value: 3000, auto: false }];
    cfg.proxy.routes.push({
      name: "api",
      match: { host: "api.local", path: "" },
      upstream: { url: "", service: "api", port: "http" },
      auth: emptyRouteAuth(),
    });
    expect(validate(cfg)).toEqual([]);
  });

  test("rejects a service-reference upstream to an unknown service", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "nope",
      match: { host: "nope.local", path: "" },
      upstream: { url: "", service: "ghost", port: "http" },
      auth: emptyRouteAuth(),
    });
    expect(validate(cfg)).toContain("proxy.routes[0].upstream.service references unknown service ghost");
  });

  test("rejects a service-reference upstream to a port the service does not declare", () => {
    const cfg = withService("api");
    cfg.services.api!.ports = [{ name: "grpc", value: 50051, auto: false }];
    cfg.proxy.routes.push({
      name: "api",
      match: { host: "api.local", path: "" },
      upstream: { url: "", service: "api", port: "http" },
      auth: emptyRouteAuth(),
    });
    expect(validate(cfg)).toContain("proxy.routes[0].upstream: service api has no port named http");
  });

  test("rejects a route with neither url nor service", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "empty",
      match: { host: "empty.local", path: "" },
      upstream: { url: "", service: "", port: "" },
      auth: emptyRouteAuth(),
    });
    expect(validate(cfg)).toContain("proxy.routes[0].upstream requires either url, service, or recipe");
  });

  test("rejects IAP routes without identity type", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { type: "iap", identity: { type: "", service_account: "" }, audience: "/projects/1/iap", service_account: "", client_id: "", client_secret: "" },
    });
    expect(validate(cfg).some((issue) => issue.includes("identity.type is required"))).toBe(true);
  });

  test("warns when a proxy auth header contains ${identity. and stays silent otherwise", () => {
    const warned = withService("api");
    warned.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: iapUserAuth({ headers: { "X-User": "${identity.user}" } }),
    });
    expect(validate(warned)).toContain(
      "warning: proxy.routes[0].auth.headers.X-User contains ${identity. which is not resolved on proxy headers (only service env at start)",
    );

    const clean = withService("api");
    clean.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: iapUserAuth({ headers: { "identity-token": "${token}", "x-custom": "literal" } }),
    });
    expect(validate(clean).some((issue) => issue.includes("${identity."))).toBe(false);
    expect(validate(clean)).toEqual([]);
  });

  test("accepts ${env.NAME} in service env, route headers, upstream url, and credentials", () => {
    const cfg = withService("api");
    cfg.services.api!.environment.vars.API_KEY = "${env.API_KEY}";
    cfg.services.api!.environment.defaults.FALLBACK = "${FALLBACK}";
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://${env.BILLING_HOST}" },
      auth: iapUserAuth({
        client_id: "desktop.apps.googleusercontent.com",
        client_secret: "${env.IAP_OAUTH_CLIENT_SECRET}",
        credentials: "${env.IAP_CREDENTIALS}",
        headers: { "X-Api-Key": "${env.API_KEY}" },
      }),
      response_headers: { "X-Env": "${env.CORS_ORIGIN}" },
    });
    expect(validate(cfg).filter((issue) => !isValidationWarning(issue))).toEqual([]);
  });

  test("accepts ${env.NAME} in HTTP recipe request, audience, and credentials", () => {
    const cfg = withService("api");
    cfg.http.login = {
      request: {
        method: "POST",
        url: "https://${env.API_HOST}/token",
        headers: { Authorization: "Basic ${env.BASIC}" },
        body: "",
        form: { client_secret: "${CLIENT_SECRET}" },
        auth: {
          ...emptyRouteAuth(),
          type: "iap",
          audience: "${env.IAP_AUDIENCE}",
          identity: { type: "user", service_account: "" },
          client_id: "desktop.apps.googleusercontent.com",
          client_secret: "${env.IAP_OAUTH_CLIENT_SECRET}",
          credentials: "${env.IAP_CREDENTIALS}",
          headers: { "X-Api-Key": "${env.API_KEY}" },
        },
        timeout_seconds: 10,
      },
      outputs: {},
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    expect(validate(cfg).filter((issue) => !isValidationWarning(issue))).toEqual([]);
  });

  test("rejects non-env template refs on proxy route strings", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://${services.api.port}" },
      auth: emptyRouteAuth(),
    });
    expect(validate(cfg)).toContain("proxy.routes[0].upstream.url: unresolvable reference ${services.api.port}");
  });

  test("accepts an IAP user route with client_id and an env-ref client_secret", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: iapUserAuth({ client_id: "desktop.apps.googleusercontent.com", client_secret: "${IAP_OAUTH_CLIENT_SECRET}" }),
    });
    expect(validate(cfg)).toEqual([]);
  });

  test("accepts an IAP route with client_id + credentials file and no inline client_secret", () => {
    const path = join(process.env.TMPDIR ?? "/tmp", `devctl-iap-ok-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({
      type: "authorized_user",
      client_id: "desktop.apps.googleusercontent.com",
      client_secret: "file-secret",
      refresh_token: "rt-1",
    }));
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { ...iapUserAuth(), client_id: "desktop.apps.googleusercontent.com", credentials: path },
    });
    expect(validate(cfg)).toEqual([]);
  });

  test("rejects a missing IAP credentials file, a file without refresh_token, and a client_id mismatch", () => {
    const missing = withService("api");
    missing.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { ...iapUserAuth(), client_id: "cid", credentials: "/no/such/devctl-iap.json" },
    });
    expect(validate(missing)).toContain("proxy.routes[0].auth.credentials file not found: /no/such/devctl-iap.json");

    const noToken = join(process.env.TMPDIR ?? "/tmp", `devctl-iap-notoken-${Date.now()}.json`);
    writeFileSync(noToken, JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "s" }));
    const noRefresh = withService("api");
    noRefresh.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { ...iapUserAuth(), client_id: "cid", credentials: noToken },
    });
    expect(validate(noRefresh)).toContain("proxy.routes[0].auth.credentials has no refresh_token");

    const mismatch = join(process.env.TMPDIR ?? "/tmp", `devctl-iap-mismatch-${Date.now()}.json`);
    writeFileSync(mismatch, JSON.stringify({ type: "authorized_user", client_id: "other", refresh_token: "rt" }));
    const wrongClient = withService("api");
    wrongClient.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { ...iapUserAuth(), client_id: "cid", credentials: mismatch },
    });
    expect(validate(wrongClient)).toContain("proxy.routes[0].auth.credentials client_id does not match auth.client_id");
  });

  test("accepts log_identity on auth none and rejects it on IAP", () => {
    const none = withService("api");
    none.proxy.routes.push({
      name: "local",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: { ...emptyRouteAuth(), type: "none", log_identity: true },
    });
    expect(validate(none)).toEqual([]);

    const iap = withService("api");
    iap.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { ...iapUserAuth(), log_identity: true },
    });
    expect(validate(iap)).toContain("proxy.routes[0].auth.log_identity is only valid when auth.type is none");
  });

  test("accepts suppress_authorization on IAP with headers and rejects it on none or without headers", () => {
    const ok = withService("api");
    ok.proxy.routes.push({
      name: "workspace",
      match: { host: "", path: "" },
      upstream: { url: "https://example.com" },
      auth: iapUserAuth({ suppress_authorization: true, headers: { "Proxy-Authorization": "Bearer ${token}" } }),
    });
    expect(validate(ok)).toEqual([]);

    const none = withService("api");
    none.proxy.routes.push({
      name: "local",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: { ...emptyRouteAuth(), type: "none", suppress_authorization: true, headers: { "Proxy-Authorization": "Bearer ${token}" } },
    });
    expect(validate(none)).toContain("proxy.routes[0].auth.suppress_authorization is only valid when auth.type is iap or service_account");

    const noHeaders = withService("api");
    noHeaders.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: iapUserAuth({ suppress_authorization: true }),
    });
    expect(validate(noHeaders)).toContain("proxy.routes[0].auth.suppress_authorization requires auth.headers");
  });

  test("rejects auth.credentials without a client_id", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { ...iapUserAuth(), credentials: "/abs/iap.json" },
    });
    expect(validate(cfg)).toContain("proxy.routes[0].auth.credentials requires auth.client_id");
  });

  test("accepts a valid grpc route and rejects bad ones", () => {
    const grpc = (name: string, port: number, url: string) => ({
      name, transport: "grpc", listen: { host: "127.0.0.1", port }, match: { host: "", path: "" }, upstream: { url }, auth: emptyRouteAuth(),
    });
    const ok = withService("api");
    ok.proxy.routes.push(grpc("temporal", 7233, "https://temporal.internal:443"));
    expect(validate(ok)).toEqual([]);

    const noPort = withService("api");
    noPort.proxy.routes.push({ name: "t", transport: "grpc", match: { host: "", path: "" }, upstream: { url: "https://t:443" }, auth: emptyRouteAuth() });
    expect(validate(noPort)).toContain("proxy.routes[0].listen.port is required for a grpc route");

    const plainUpstream = withService("api");
    plainUpstream.proxy.routes.push(grpc("t", 7233, "http://t:443"));
    expect(validate(plainUpstream)).toContain("proxy.routes[0].upstream.url must be an https:// address for a grpc route");

    const dupe = withService("api");
    dupe.proxy.routes.push(grpc("a", 7233, "https://t:443"), grpc("b", 7233, "https://t:443"));
    expect(validate(dupe).some((i) => i.includes("already used by another grpc route"))).toBe(true);

    const typo = withService("api");
    typo.proxy.routes.push({ ...grpc("t", 7233, "https://t:443"), transport: "gprc" });
    expect(validate(typo)).toContain('proxy.routes[0].transport must be "http" or "grpc"');

    const withMatch = withService("api");
    withMatch.proxy.routes.push({ ...grpc("t", 7233, "https://t:443"), match: { host: "t.local", path: "" } });
    expect(validate(withMatch)).toContain("proxy.routes[0].match is not supported on a grpc route");

    const tokenClash = withService("api");
    tokenClash.proxy.token_endpoint = { enabled: true, host: "127.0.0.1", port: 7233 };
    tokenClash.proxy.routes.push(grpc("t", 7233, "https://t:443"));
    expect(tokenClash.proxy.routes.length).toBe(1);
    expect(validate(tokenClash)).toContain("proxy.routes[0].listen.port must differ from proxy.token_endpoint.port");

    const respHeaders = withService("api");
    respHeaders.proxy.routes.push({ ...grpc("t", 7233, "https://t:443"), response_headers: { "Access-Control-Allow-Origin": "*" } });
    expect(validate(respHeaders)).toContain("proxy.routes[0].response_headers is not supported on a grpc route");

    const transformed = withService("api");
    transformed.proxy.routes.push({
      ...grpc("t", 7233, "https://t:443"),
      transform: { request_body: [{ replace: "http://127.0.0.1:1", with: "https://remote.example.com" }] },
    });
    expect(validate(transformed)).toContain("proxy.routes[0].transform is not supported on a grpc route");
  });

  test("accepts request body transforms and rejects empty, invalid, and unresolved patterns", () => {
    const ok = withService("api");
    ok.proxy.routes.push({
      name: "api",
      match: { host: "", path: "/api" },
      upstream: { url: "https://remote.example.com" },
      auth: emptyRouteAuth(),
      transform: {
        request_body: [
          { replace: "http://127.0.0.1:${env.PROXY_PORT}", with: "https://remote.example.com" },
          { replace: "http://127\\.0\\.0\\.1:\\d+", with: "${PUBLIC_ORIGIN}", regex: true },
        ],
      },
    });
    expect(validate(ok)).toEqual([]);

    const empty = withService("api");
    empty.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "https://remote.example.com" },
      auth: emptyRouteAuth(),
      transform: { request_body: [{ replace: "", with: "x" }] },
    });
    expect(validate(empty)).toContain("proxy.routes[0].transform.request_body[0].replace is required");

    const badRegex = withService("api");
    badRegex.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "https://remote.example.com" },
      auth: emptyRouteAuth(),
      transform: { request_body: [{ replace: "(", with: "x", regex: true }] },
    });
    expect(validate(badRegex).some((issue) => issue.includes("not a valid regular expression"))).toBe(true);

    const emptyMatch = withService("api");
    emptyMatch.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "https://remote.example.com" },
      auth: emptyRouteAuth(),
      transform: { request_body: [{ replace: ".*", with: "x", regex: true }] },
    });
    expect(validate(emptyMatch)).toContain("proxy.routes[0].transform.request_body[0].replace matches an empty string");

    const token = withService("api");
    token.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "https://remote.example.com" },
      auth: emptyRouteAuth(),
      transform: { request_body: [{ replace: "${token}", with: "x" }] },
    });
    expect(validate(token)).toContain("proxy.routes[0].transform.request_body[0].replace: unresolvable reference ${token}");

    const identity = withService("api");
    identity.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "https://remote.example.com" },
      auth: emptyRouteAuth(),
      transform: { request_body: [{ replace: "user", with: "${identity.user}" }] },
    });
    expect(validate(identity)).toContain(
      "warning: proxy.routes[0].transform.request_body[0].with contains ${identity. which is not resolved on a request body transform (only service env at start)",
    );

    const recipe = withService("api");
    recipe.http.login = {
      request: { method: "GET", url: "https://idp.example/token", headers: {}, body: "", form: {}, auth: emptyRouteAuth(), timeout_seconds: 0 },
      outputs: {},
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    recipe.proxy.routes.push({
      name: "login",
      match: { host: "login.local", path: "" },
      upstream: { url: "", recipe: "login" },
      auth: emptyRouteAuth(),
      transform: { request_body: [{ replace: "a", with: "b" }] },
    });
    expect(validate(recipe)).toContain("proxy.routes[0].transform is not supported on a recipe route");
  });

  test("rejects invalid log.grpc.ok log levels and accepts info|silent", () => {
    const ok = withService("api");
    ok.proxy.routes.push({
      name: "temporal",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      log: { grpc: { ok: [{ status: 14, methods: ["PollWorkflowTaskQueue"], log: "silent" }, { status: 3, log: "info" }] } },
    });
    expect(validate(ok).filter((issue) => issue.includes("log.grpc"))).toEqual([]);
    const bad = withService("api");
    bad.proxy.routes.push({
      name: "temporal",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      log: { grpc: { ok: [{ status: 14, log: "debug" as "info" }] } },
    });
    expect(validate(bad)).toContain('proxy.routes[0].log.grpc.ok[0].log must be "info" or "silent"');
  });

  test("keeps malformed log.grpc.ok entries so validate can reject them", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push(decodeRoute({
      name: "temporal",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      log: { grpc: { ok: [14, { methods: ["PollWorkflowTaskQueue"] }] } },
    }));
    const issues = validate(cfg);
    expect(issues).toContain("proxy.routes[0].log.grpc.ok[0].status must be a number");
    expect(issues).toContain("proxy.routes[0].log.grpc.ok[1].status must be a number");
  });

  test("rejects log.grpc.ok status outside the non-zero gRPC range", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "temporal",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      log: { grpc: { ok: [{ status: 0 }, { status: 17 }, { status: 14.5 }] } },
    });
    const issues = validate(cfg);
    expect(issues).toContain("proxy.routes[0].log.grpc.ok[0].status must be an integer from 1 to 16");
    expect(issues).toContain("proxy.routes[0].log.grpc.ok[1].status must be an integer from 1 to 16");
    expect(issues).toContain("proxy.routes[0].log.grpc.ok[2].status must be an integer from 1 to 16");
  });

  test("rejects negative or non-finite timeout idle_ms / total_ms and accepts omitted or 0", () => {
    const ok = withService("api");
    ok.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
    });
    expect(validate(ok).filter((issue) => issue.includes("timeout"))).toEqual([]);
    ok.proxy.routes[0]!.timeout = { idle_ms: 0, total_ms: 0 };
    expect(validate(ok).filter((issue) => issue.includes("timeout"))).toEqual([]);
    ok.proxy.routes[0]!.timeout = { idle_ms: 120000, total_ms: 300000 };
    expect(validate(ok).filter((issue) => issue.includes("timeout"))).toEqual([]);
    const badIdle = withService("api");
    badIdle.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      timeout: { idle_ms: -1 },
    });
    expect(validate(badIdle)).toContain("proxy.routes[0].timeout.idle_ms must be a finite number >= 0");
    const badTotal = withService("api");
    badTotal.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      timeout: { total_ms: -5 },
    });
    expect(validate(badTotal)).toContain("proxy.routes[0].timeout.total_ms must be a finite number >= 0");
    const badString = withService("api");
    badString.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      timeout: { idle_ms: Number.NaN, total_ms: Number.POSITIVE_INFINITY },
    });
    expect(validate(badString)).toContain("proxy.routes[0].timeout.idle_ms must be a finite number >= 0");
    expect(validate(badString)).toContain("proxy.routes[0].timeout.total_ms must be a finite number >= 0");
  });

  test("rejects negative inspect.max_bytes and accepts omitted inspect", () => {
    const ok = withService("api");
    ok.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      inspect: { enabled: true, max_bytes: 0 },
    });
    expect(validate(ok).filter((issue) => issue.includes("inspect"))).toEqual([]);
    const bad = withService("api");
    bad.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      inspect: { enabled: true, max_bytes: -1 },
    });
    expect(validate(bad)).toContain("proxy.routes[0].inspect.max_bytes must be >= 0");
    const negDefault = withService("api");
    negDefault.proxy.inspect_max_bytes = -1;
    expect(validate(negDefault)).toContain("proxy.inspect_max_bytes must be a finite number >= 0");
    const invalidDefault = withService("api");
    invalidDefault.proxy.inspect_max_bytes = Number.NaN;
    expect(validate(invalidDefault)).toContain("proxy.inspect_max_bytes must be a finite number >= 0");
    const infiniteDefault = withService("api");
    infiniteDefault.proxy.inspect_max_bytes = Number.POSITIVE_INFINITY;
    expect(validate(infiniteDefault)).toContain("proxy.inspect_max_bytes must be a finite number >= 0");
    const negLlm = withService("api");
    negLlm.llm.capture_max_bytes = -1;
    expect(validate(negLlm)).toContain("llm.capture_max_bytes must be a finite number >= 0");
    const invalidLlm = withService("api");
    invalidLlm.llm.capture_max_bytes = Number.NaN;
    expect(validate(invalidLlm)).toContain("llm.capture_max_bytes must be a finite number >= 0");
    const negSource = withService("api");
    negSource.llm.enabled = true;
    const source = emptyLlmSource();
    source.name = "llm";
    source.type = "proxy";
    source.via.route = "api";
    source.capture.max_bytes = -1;
    negSource.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
    });
    negSource.llm.sources = [source];
    expect(validate(negSource)).toContain("llm.sources[0].capture.max_bytes must be >= 0");
  });

  test("rejects an unknown inspect.grpc.decoder when plugins are empty", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
      inspect: { enabled: true, max_bytes: 0, grpc: { decoder: "temporal" } },
    });
    expect(validate(cfg)).toContain("proxy.routes[0].inspect.grpc.decoder must be a registered plugin traffic decoder");
    expect(unresolvedInspectDecoders(cfg)).toEqual([{ route: "api", decoder: "temporal" }]);

    cfg.plugins = [{ path: "./plugin.ts" }];
    expect(validate(cfg).filter((issue) => issue.includes("inspect.grpc.decoder"))).toEqual([]);
  });

  test("rejects a mixed client_secret that is not a whole ${…} reference", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: iapUserAuth({ client_id: "desktop.apps.googleusercontent.com", client_secret: "pre-${IAP_OAUTH_CLIENT_SECRET}" }),
    });
    expect(validate(cfg)).toContain("proxy.routes[0].auth.client_secret must be a literal or a single ${NAME} / ${env.NAME} reference");
  });

  test("rejects IAP client_id without a secret", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: iapUserAuth({ client_id: "desktop.apps.googleusercontent.com" }),
    });
    expect(validate(cfg)).toContain("proxy.routes[0].auth.client_secret is required when client_id is set");
  });

  test("rejects IAP client_secret without client_id", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: iapUserAuth({ client_secret: "${IAP_OAUTH_CLIENT_SECRET}" }),
    });
    expect(validate(cfg)).toContain("proxy.routes[0].auth.client_id is required when client_secret is set");
  });

  test("rejects OAuth client fields on a non-IAP route", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "local",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: { ...emptyRouteAuth(), type: "none", identity: { type: "user", service_account: "" }, client_id: "desktop.apps.googleusercontent.com", client_secret: "${IAP_OAUTH_CLIENT_SECRET}" },
    });
    expect(validate(cfg)).toContain("proxy.routes[0].auth.client_id is only valid when auth.type is iap");
  });

  test("rejects IAP client_id with a service-account identity", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: {
        ...iapUserAuth({ client_id: "desktop.apps.googleusercontent.com", client_secret: "${IAP_OAUTH_CLIENT_SECRET}" }),
        identity: { type: "service_account", service_account: "api@example.com" },
      },
    });
    expect(validate(cfg)).toContain("proxy.routes[0].auth.client_id is only valid with identity.type user");
  });

  test("rejects shell metacharacters without shell: true", () => {
    const cfg = withService("api", ["echo", "hi", "&&", "rm"]);
    expect(validate(cfg).some((issue) => issue.includes("shell metacharacters"))).toBe(true);
  });

  test("rejects unknown capabilities", () => {
    const cfg = withService("api");
    cfg.services.api!.capabilities = ["laser"];
    expect(validate(cfg).some((issue) => issue.includes("unknown capability"))).toBe(true);
  });

  test("rejects token endpoint bound to 0.0.0.0", () => {
    const cfg = withService("api");
    cfg.proxy.token_endpoint = { enabled: true, host: "0.0.0.0", port: 0 };
    expect(validate(cfg).some((issue) => issue.includes("loopback"))).toBe(true);
  });

  test("rejects proxy listen on ::", () => {
    const cfg = withService("api");
    cfg.proxy.listen.host = "::";
    expect(validate(cfg).some((issue) => issue.includes("loopback"))).toBe(true);
  });

  test("rejects token endpoint bound to ::", () => {
    const cfg = withService("api");
    cfg.proxy.token_endpoint = { enabled: true, host: "::", port: 0 };
    expect(validate(cfg).some((issue) => issue.includes("loopback"))).toBe(true);
  });

  test("rejects OTLP listen on 0.0.0.0", () => {
    const cfg = withService("api");
    cfg.telemetry.otlp.enabled = true;
    cfg.telemetry.otlp.listen.host = "0.0.0.0";
    expect(validate(cfg).some((issue) => issue.includes("loopback"))).toBe(true);
  });

  test("rejects web listen on 0.0.0.0", () => {
    const cfg = withService("api");
    cfg.web.enabled = true;
    cfg.web.listen.host = "0.0.0.0";
    expect(validate(cfg).some((issue) => issue.includes("web.listen.host must be a loopback address"))).toBe(true);
  });

  test("rejects web listen on ::", () => {
    const cfg = withService("api");
    cfg.web.listen.host = "::";
    expect(validate(cfg).some((issue) => issue.includes("web.listen.host must be a loopback address"))).toBe(true);
  });

  test("rejects an invalid web listen port", () => {
    const cfg = withService("api");
    cfg.web.listen.port = 70000;
    expect(validate(cfg).some((issue) => issue.includes("web.listen.port is invalid"))).toBe(true);
  });

  test("rejects web port colliding with proxy listen", () => {
    const cfg = withService("api");
    cfg.proxy.listen.port = 18900;
    cfg.web.listen.port = 18900;
    expect(validate(cfg)).toContain("web.listen.port must differ from proxy.listen.port");
  });

  test("rejects web port colliding with token endpoint", () => {
    const cfg = withService("api");
    cfg.proxy.token_endpoint = { enabled: true, host: "127.0.0.1", port: 18900 };
    cfg.web.listen.port = 18900;
    expect(validate(cfg)).toContain("web.listen.port must differ from proxy.token_endpoint.port");
  });

  test("rejects web port colliding with OTLP", () => {
    const cfg = withService("api");
    cfg.telemetry.otlp.listen.port = 18900;
    cfg.web.listen.port = 18900;
    expect(validate(cfg)).toContain("web.listen.port must differ from telemetry.otlp.listen.port");
  });

  test("rejects web port colliding with a gRPC route listen port", () => {
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "worker",
      transport: "grpc",
      match: { host: "worker.local", path: "" },
      upstream: { url: "https://127.0.0.1:9000" },
      auth: emptyRouteAuth(),
      listen: { host: "127.0.0.1", port: 18900 },
    });
    cfg.web.listen.port = 18900;
    expect(validate(cfg)).toContain("web.listen.port must differ from proxy.routes[0].listen.port");
  });

  test("validates plugin paths relative to the repository root", () => {
    const root = join(process.env.TMPDIR ?? "/tmp", `devctl-validate-${Date.now()}-${Math.random()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "plugin.ts"), "export const sdkVersion = 1;\n");
    const cfg = withService("api");
    cfg.repoRoot = root;
    cfg.plugins = [{ path: "./plugin.ts" }];
    expect(validate(cfg).some((issue) => issue.includes("plugins.0.path"))).toBe(false);
    cfg.plugins = [{ path: "./missing.ts" }];
    expect(validate(cfg)).toContain("plugins.0.path does not exist: ./missing.ts");
    cfg.plugins = [{ path: "../escape.ts" }];
    expect(validate(cfg).some((issue) => issue.includes("plugins.0.path") && issue.includes("inside the repository root"))).toBe(true);
    cfg.plugins = [{ path: "/etc/evil.ts" }];
    expect(validate(cfg).some((issue) => issue.includes("plugins.0.path") && issue.includes("inside the repository root"))).toBe(true);
  });

  test("rejects reserved http outputs, expose without proxy, missing outputs, and recipe cycles", () => {
    const missing = withService("api");
    missing.services.api!.environment.vars.TOKEN = "${http.login.token}";
    expect(validate(missing).some((issue) => issue.includes("unresolvable reference ${http.login.token}"))).toBe(true);

    const reserved = withService("api");
    reserved.http.login = {
      request: { method: "POST", url: "https://idp.example/token", headers: {}, body: "", form: {}, auth: emptyRouteAuth(), timeout_seconds: 10 },
      outputs: { body: "access_token" },
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    expect(validate(reserved)).toContain("http.login.outputs.body is reserved");

    const expose = withService("api");
    expose.http.login = {
      request: { method: "GET", url: "https://idp.example/token", headers: {}, body: "", form: {}, auth: emptyRouteAuth(), timeout_seconds: 0 },
      outputs: {},
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: true, host: "", response_headers: {}, allow_token_body: false },
    };
    expect(validate(expose)).toContain("http.login.expose requires proxy.enabled");

    const cycle = withService("api");
    const auth = emptyRouteAuth();
    cycle.http.a = {
      request: { method: "GET", url: "https://a.example/${http.b.token}", headers: {}, body: "", form: {}, auth, timeout_seconds: 0 },
      outputs: { token: "access_token" },
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    cycle.http.b = {
      request: { method: "GET", url: "https://b.example/${http.a.token}", headers: {}, body: "", form: {}, auth, timeout_seconds: 0 },
      outputs: { token: "access_token" },
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    expect(validate(cycle).some((issue) => issue.includes("http recipe cycle"))).toBe(true);
  });

  test("rejects both body and form, and ${token} without minting auth", () => {
    const cfg = withService("api");
    cfg.http.login = {
      request: {
        method: "POST",
        url: "https://idp.example/token",
        headers: {},
        body: "raw",
        form: { grant_type: "client_credentials" },
        auth: emptyRouteAuth(),
        timeout_seconds: 0,
      },
      outputs: {},
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    expect(validate(cfg)).toContain("http.login.request cannot set both body and form");
    cfg.http.login.request.body = "";
    cfg.http.login.request.form = { subject_token: "${token}" };
    expect(validate(cfg)).toContain("http.login: ${token} requires request.auth.type iap or service_account");
  });

  test("rejects a literal recipe URL that targets a link-local / metadata host", () => {
    const cfg = withService("api");
    cfg.http.meta = {
      request: { method: "GET", url: "http://169.254.169.254/computeMetadata/v1/", headers: {}, body: "", form: {}, auth: emptyRouteAuth(), timeout_seconds: 0 },
      outputs: {},
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    expect(validate(cfg).some((issue) => issue.includes("targets a link-local or metadata host"))).toBe(true);

    // An interpolated URL is not host-checked at validate time (enforced at fetch).
    cfg.http.meta.request.url = "https://${env.API_HOST}/token";
    expect(validate(cfg).some((issue) => issue.includes("targets a link-local or metadata host"))).toBe(false);
  });

  test("refuses exposing a token-bearing recipe body without allow_token_body", () => {
    const cfg = withService("api");
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port: 18800 };
    cfg.http.login = {
      request: { method: "POST", url: "https://idp.example/token", headers: {}, body: "", form: {}, auth: emptyRouteAuth(), timeout_seconds: 10 },
      outputs: { token: "access_token" },
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: true, host: "login.local", response_headers: {}, allow_token_body: false },
    };
    expect(validate(cfg).some((issue) => issue.includes("expose serves a token-bearing body"))).toBe(true);

    cfg.http.login.expose.allow_token_body = true;
    expect(validate(cfg).some((issue) => issue.includes("expose serves a token-bearing body"))).toBe(false);

    // A JWT-cached body is token material even without a named token output.
    cfg.http.login.outputs = {};
    cfg.http.login.cache = { jwt: true, expires_in: "" };
    cfg.http.login.expose.allow_token_body = false;
    expect(validate(cfg).some((issue) => issue.includes("expose serves a token-bearing body"))).toBe(true);

    // An opaque refresh_token output is a credential too, even without cache.jwt.
    cfg.http.login.cache = { jwt: false, expires_in: "" };
    cfg.http.login.outputs = { refresh: "refresh_token" };
    expect(validate(cfg).some((issue) => issue.includes("expose serves a token-bearing body"))).toBe(true);
  });

  test("rejects unknown llm source types and missing management hops", () => {
    const cfg = withService("litellm");
    cfg.services.litellm!.ports = [{ name: "http", value: 4000, auto: false }];
    cfg.llm.enabled = true;
    expect(validate(cfg)).toContain("llm.sources must list at least one source when llm.enabled is true");
    cfg.llm.sources = [{
      name: "platform",
      type: "openai_compat",
      service: "",
      port: "",
      endpoint: "",
      path_prefix: "",
      headers: {},
      via: { route: "", routes: [] },
      management_endpoint: "",
      management_service: "",
      management_port: "",
      auth: { type: "bearer", token_env: "", header: "" },
      capture: { prompts: true, max_bytes: 0, paths: [] },
      poll_seconds: 0,
    }];
    const issues = validate(cfg);
    expect(issues.some((issue) => issue.includes("type must be one of litellm, proxy"))).toBe(true);
    expect(issues.some((issue) => issue.includes("exactly one management hop"))).toBe(true);
    expect(issues.some((issue) => issue.includes("token_env is required"))).toBe(true);
  });

  test("accepts a proxy source that captures from an existing via.route", () => {
    const cfg = withService("litellm");
    cfg.proxy.routes.push({
      name: "apigee-llm",
      match: { host: "", path: "/llm" },
      upstream: { url: "https://gateway.example/llm" },
      auth: emptyRouteAuth(),
    });
    cfg.llm.enabled = true;
    cfg.llm.sources = [{
      name: "apigee-llm",
      type: "proxy",
      service: "",
      port: "",
      endpoint: "",
      path_prefix: "",
      headers: {},
      via: { route: "apigee-llm", routes: [] },
      management_endpoint: "",
      management_service: "",
      management_port: "",
      auth: { type: "", token_env: "", header: "" },
      capture: { prompts: true, max_bytes: 0, paths: [] },
      poll_seconds: 0,
    }];
    expect(validate(cfg)).toEqual([]);
    cfg.llm.sources[0]!.via.route = "  apigee-llm  ";
    expect(validate(cfg)).toEqual([]);
  });

  test("rejects a proxy source with no via.route and with management/service fields", () => {
    const cfg = withService("litellm");
    cfg.services.litellm!.ports = [{ name: "http", value: 4000, auto: false }];
    cfg.llm.enabled = true;
    cfg.llm.sources = [{
      name: "apigee-llm",
      type: "proxy",
      service: "litellm",
      port: "",
      endpoint: "",
      path_prefix: "",
      headers: {},
      via: { route: "", routes: [] },
      management_endpoint: "http://127.0.0.1:4000",
      management_service: "",
      management_port: "",
      auth: { type: "", token_env: "", header: "" },
      capture: { prompts: true, max_bytes: 0, paths: [] },
      poll_seconds: 0,
    }];
    const issues = validate(cfg);
    expect(issues.some((issue) => issue.includes("type proxy requires via.route"))).toBe(true);
    expect(issues.some((issue) => issue.includes("must not set management_endpoint, service"))).toBe(true);
  });

  test("accepts a litellm source on a managed service and via.route with a separate management endpoint", () => {
    const cfg = withService("litellm");
    cfg.services.litellm!.ports = [{ name: "http", value: 4000, auto: false }];
    cfg.proxy.routes.push({
      name: "llm-apps",
      match: { host: "llm.local", path: "" },
      upstream: { url: "", service: "litellm", port: "http" },
      auth: emptyRouteAuth(),
    });
    cfg.llm.enabled = true;
    cfg.llm.sources = [{
      name: "via-gateway",
      type: "litellm",
      service: "",
      port: "",
      endpoint: "",
      path_prefix: "/llm",
      headers: {},
      via: { route: "llm-apps", routes: [] },
      management_endpoint: "http://127.0.0.1:4000",
      management_service: "",
      management_port: "",
      auth: { type: "bearer", token_env: "LITELLM_MASTER_KEY", header: "x-litellm-api-key" },
      capture: { prompts: true, max_bytes: 0, paths: [] },
      poll_seconds: 5,
    }];
    expect(validate(cfg)).toEqual([]);
  });

  test("accepts capture.paths on a proxy source and rejects empty, relative, or root entries", () => {
    const cfg = withService("litellm");
    cfg.proxy.routes.push({
      name: "apigee-llm",
      match: { host: "", path: "/llm" },
      upstream: { url: "https://gateway.example/llm" },
      auth: emptyRouteAuth(),
    });
    cfg.llm.enabled = true;
    const source: LlmSourceConfig = {
      name: "apigee-llm",
      type: "proxy",
      service: "",
      port: "",
      endpoint: "",
      path_prefix: "",
      headers: {},
      via: { route: "apigee-llm", routes: [] },
      management_endpoint: "",
      management_service: "",
      management_port: "",
      auth: { type: "", token_env: "", header: "" },
      capture: { prompts: true, max_bytes: 0, paths: ["/generations/v1alpha2"] },
      poll_seconds: 0,
    };
    cfg.llm.sources = [source];
    expect(validate(cfg)).toEqual([]);

    source.capture.paths = [""];
    expect(validate(cfg).some((issue) => issue.includes("capture.paths[0] must be a non-empty path"))).toBe(true);
    source.capture.paths = ["generations"];
    expect(validate(cfg).some((issue) => issue.includes("capture.paths[0] must start with /"))).toBe(true);
    source.capture.paths = ["/"];
    expect(validate(cfg).some((issue) => issue.includes("capture.paths[0] must name a path, not /"))).toBe(true);
  });

  test("accepts capture.field_map on a proxy source and rejects it on litellm or with a bad path", () => {
    const cfg = withService("litellm");
    cfg.proxy.routes.push({
      name: "apigee-llm",
      match: { host: "", path: "/llm" },
      upstream: { url: "https://gateway.example/llm" },
      auth: emptyRouteAuth(),
    });
    cfg.llm.enabled = true;
    const source = emptyLlmSource();
    source.name = "apigee-llm";
    source.type = "proxy";
    source.via.route = "apigee-llm";
    source.capture.field_map = { model: "$.request.model_name", cost: "$.response.metadata.price" };
    cfg.llm.sources = [source];
    expect(validate(cfg)).toEqual([]);

    source.capture.field_map = { model: "$.metadata.model" };
    expect(validate(cfg).some((issue) => issue.includes("capture.field_map.model must start with $.request. or $.response."))).toBe(true);

    source.capture.field_map = { model: "" };
    expect(validate(cfg).some((issue) => issue.includes("capture.field_map.model must be a non-empty JSON path"))).toBe(true);

    const litellm = emptyLlmSource();
    litellm.name = "spend";
    litellm.type = "litellm";
    litellm.service = "litellm";
    litellm.auth = { type: "bearer", token_env: "LITELLM_MASTER_KEY", header: "" };
    litellm.capture.field_map = { model: "$.request.model_name" };
    cfg.services.litellm!.ports = [{ name: "http", value: 4000, auto: false }];
    cfg.llm.sources = [litellm];
    expect(validate(cfg).some((issue) => issue.includes("capture.field_map is only valid on type: proxy"))).toBe(true);
  });

  test("accepts a proxy source that lists existing via.routes without via.route", () => {
    const cfg = withService("litellm");
    cfg.proxy.routes.push(
      { name: "alpha", match: { host: "", path: "/a" }, upstream: { url: "https://gateway.example/a" }, auth: emptyRouteAuth() },
      { name: "beta", match: { host: "", path: "/b" }, upstream: { url: "https://gateway.example/b" }, auth: emptyRouteAuth() },
    );
    cfg.llm.enabled = true;
    const source = emptyLlmSource();
    source.name = "multi";
    source.type = "proxy";
    source.via.routes = ["alpha", "beta"];
    cfg.llm.sources = [source];
    expect(validate(cfg)).toEqual([]);
  });

  test("rejects a proxy source with neither via.route nor via.routes", () => {
    const cfg = withService("litellm");
    cfg.llm.enabled = true;
    const source = emptyLlmSource();
    source.name = "apigee-llm";
    source.type = "proxy";
    cfg.llm.sources = [source];
    expect(validate(cfg).some((issue) => issue.includes("type proxy requires via.route or via.routes"))).toBe(true);
  });

  test("rejects unknown and empty via.routes names on a proxy source", () => {
    const cfg = withService("litellm");
    cfg.proxy.routes.push({
      name: "apigee-llm",
      match: { host: "", path: "/llm" },
      upstream: { url: "https://gateway.example/llm" },
      auth: emptyRouteAuth(),
    });
    cfg.llm.enabled = true;
    const source = emptyLlmSource();
    source.name = "apigee-llm";
    source.type = "proxy";
    source.via.routes = ["ghost"];
    cfg.llm.sources = [source];
    expect(validate(cfg).some((issue) => issue.includes("via.routes[0] references unknown proxy route ghost"))).toBe(true);

    source.via.routes = [""];
    expect(validate(cfg).some((issue) => issue.includes("via.routes[0] must be a non-empty name"))).toBe(true);
  });

  test("accepts cost_per_token on a proxy source and rejects it on litellm or with negative rates", () => {
    const cfg = withService("litellm");
    cfg.services.litellm!.ports = [{ name: "http", value: 4000, auto: false }];
    cfg.proxy.routes.push({
      name: "apigee-llm",
      match: { host: "", path: "/llm" },
      upstream: { url: "https://gateway.example/llm" },
      auth: emptyRouteAuth(),
    });
    cfg.llm.enabled = true;
    const source = emptyLlmSource();
    source.name = "apigee-llm";
    source.type = "proxy";
    source.via.route = "apigee-llm";
    source.cost_per_token = { input: 0.000001, output: 0.000002 };
    cfg.llm.sources = [source];
    expect(validate(cfg)).toEqual([]);

    source.cost_per_token = { input: -1, output: 0.000002 };
    expect(validate(cfg).some((issue) => issue.includes("cost_per_token.input must be >= 0"))).toBe(true);
    source.cost_per_token = { input: 0.000001, output: -2 };
    expect(validate(cfg).some((issue) => issue.includes("cost_per_token.output must be >= 0"))).toBe(true);

    const litellm = emptyLlmSource();
    litellm.name = "platform";
    litellm.type = "litellm";
    litellm.service = "litellm";
    litellm.auth = { type: "bearer", token_env: "LITELLM_MASTER_KEY", header: "" };
    litellm.cost_per_token = { input: 0.000001, output: 0.000002 };
    cfg.llm.sources = [litellm];
    expect(validate(cfg).some((issue) => issue.includes("cost_per_token is only valid on type: proxy"))).toBe(true);
    const decoded = withService("api");
    decoded.proxy.routes.push({
      name: "llm-apps",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: emptyRouteAuth(),
    });
    decoded.llm.enabled = true;
    const badRates = emptyLlmSource();
    badRates.name = "apps";
    badRates.type = "proxy";
    badRates.via.route = "llm-apps";
    badRates.cost_per_token = { input: Number.NaN, output: Number.NaN };
    decoded.llm.sources = [badRates];
    expect(validate(decoded).some((issue) => issue.includes("cost_per_token.input must be >= 0"))).toBe(true);
    expect(validate(decoded).some((issue) => issue.includes("cost_per_token.output must be >= 0"))).toBe(true);
  });

  test("rejects via.routes on a litellm source", () => {
    const cfg = withService("litellm");
    cfg.services.litellm!.ports = [{ name: "http", value: 4000, auto: false }];
    cfg.llm.enabled = true;
    const source = emptyLlmSource();
    source.name = "platform";
    source.type = "litellm";
    source.service = "litellm";
    source.via.routes = ["llm-apps"];
    source.auth = { type: "bearer", token_env: "LITELLM_MASTER_KEY", header: "" };
    cfg.llm.sources = [source];
    expect(validate(cfg).some((issue) => issue.includes("via.routes is only valid on type: proxy"))).toBe(true);
  });

  test("named environments require a known default_environment and reject empty names", () => {
    const cfg = withService("api");
    cfg.services.api!.environments = {
      local: { vars: { MODE: "local" }, required: [], defaults: {} },
      deployed: { vars: { MODE: "deployed" }, required: [], defaults: {} },
    };
    cfg.services.api!.default_environment = "staging";
    expect(validate(cfg)).toContain('services.api.default_environment "staging" is not defined in environments');
    cfg.services.api!.default_environment = "local";
    cfg.services.api!.environments[""] = { vars: {}, required: [], defaults: {} };
    expect(validate(cfg)).toContain("services.api.environments has an empty name");
  });

  test("profile overlay bind and service_environment must name known services and overlays", () => {
    const cfg = withService("api");
    cfg.services.api!.environments = {
      deployed: { vars: { MODE: "deployed" }, required: [], defaults: {} },
    };
    cfg.profiles.console = emptyProfile({
      services: ["api"],
      environments: { ghost: "deployed" },
    });
    expect(validate(cfg)).toContain('profiles.console.environments.ghost references unknown service "ghost"');
    cfg.profiles.console = emptyProfile({
      services: ["api"],
      environments: { api: "staging" },
    });
    expect(validate(cfg)).toContain('profiles.console.environments.api "staging" is not defined on services.api');
    cfg.profiles.console = emptyProfile({
      services: ["api"],
      environments: { api: "deployed" },
      service_environment: { ghost: { vars: { FLAG: "1" }, required: [], defaults: {} } },
    });
    expect(validate(cfg)).toContain('profiles.console.service_environment.ghost references unknown service "ghost"');
    cfg.profiles.console = emptyProfile({
      services: ["api"],
      environments: { api: "deployed" },
      service_environment: { api: { vars: { FLAG: "1" }, required: [], defaults: {} } },
    });
    expect(validate(cfg)).toEqual([]);
  });

  test("unknown health type is rejected when plugins are empty; grpc is accepted", () => {
    const unknown = withService("api");
    unknown.services.api!.health.type = "laser";
    expect(validate(unknown)).toContain("services.api.health.type must be http, tcp, process, command, or grpc");

    const grpc = withService("api");
    grpc.services.api!.health.type = "grpc";
    grpc.services.api!.health.address = "127.0.0.1:9090";
    expect(validate(grpc)).toEqual([]);

    const missing = withService("api");
    missing.services.api!.health.type = "grpc";
    missing.services.api!.ports = [{ name: "grpc", value: 9090, auto: false }];
    expect(validate(missing)).toContain("services.api.health.address is required for grpc health checks");
  });

  test("rejects invalid logs.multiline regex and negative limits", () => {
    const cfg = withService("api");
    cfg.services.api!.logs.multiline = { start: "(", max_wait_ms: -1, max_lines: -2 };
    const issues = validate(cfg);
    expect(issues.some((issue) => issue.includes("logs.multiline.start is not a valid regular expression"))).toBe(true);
    expect(issues).toContain("services.api.logs.multiline.max_wait_ms must be >= 0");
    expect(issues).toContain("services.api.logs.multiline.max_lines must be >= 0");
  });

  test("rejects logs.dedupe_access_line when it is not a boolean", () => {
    const cfg = withService("api");
    cfg.services.api!.logs.dedupe_access_line = "yes" as unknown as boolean;
    expect(validate(cfg)).toContain("services.api.logs.dedupe_access_line must be a boolean");
    cfg.services.api!.logs.dedupe_access_line = true;
    expect(validate(cfg)).not.toContain("services.api.logs.dedupe_access_line must be a boolean");
  });
});
