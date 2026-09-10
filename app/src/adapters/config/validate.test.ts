import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyService, emptyRouteAuth, defaultConfig, type RouteAuthConfig } from "../../domain/config/types.ts";
import { validate } from "./validate.ts";

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
    expect(validate(cfg)).toContain("proxy.routes[0].upstream requires either url or service");
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
  });
});
