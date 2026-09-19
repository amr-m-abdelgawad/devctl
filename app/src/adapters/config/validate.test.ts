import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyService, emptyRouteAuth, emptyProfile, defaultConfig, type RouteAuthConfig, type LlmSourceConfig } from "../../domain/config/types.ts";
import { unresolvedInspectDecoders, validate } from "./validate.ts";

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
    const cfg = withService("api");
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { ...iapUserAuth(), client_id: "desktop.apps.googleusercontent.com", credentials: "/abs/iap.json" },
    });
    expect(validate(cfg)).toEqual([]);
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
      via: { route: "" },
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
      via: { route: "apigee-llm" },
      management_endpoint: "",
      management_service: "",
      management_port: "",
      auth: { type: "", token_env: "", header: "" },
      capture: { prompts: true, max_bytes: 0, paths: [] },
      poll_seconds: 0,
    }];
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
      via: { route: "" },
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
      via: { route: "llm-apps" },
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
      via: { route: "apigee-llm" },
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
});
