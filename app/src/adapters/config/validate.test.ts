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
