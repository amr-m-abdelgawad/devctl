import { createServer } from "node:http";
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config/types.ts";
import { startMockIapServer } from "./testdata/mock-iap-server.ts";
import { KindProxy } from "./errors.ts";
import { LogManager } from "./logs.ts";
import { INTERNAL_TOKEN_HEADER, matchRoute, ProxyServer, TokenEndpoint } from "./proxy.ts";
import { Detector } from "./secrets.ts";
import { TokenManager, type AccessToken } from "./token.ts";

function token(partial: Partial<AccessToken> = {}): AccessToken {
  return {
    accessToken: "secret-token",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 60_000),
    audience: "",
    identity: "user",
    scopes: [],
    ...partial,
  };
}

describe("proxy", () => {
  test("matchRoute uses host and path prefix", () => {
    const routes = defaultConfig().proxy.routes;
    routes.push({
      name: "billing",
      match: { host: "billing.local", path: "/v1" },
      upstream: { url: "https://example.com" },
      auth: { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "" },
    });
    expect(matchRoute(routes, { headers: { host: "billing.local:80" }, url: "/v1/orders" } as never)?.name).toBe("billing");
    expect(matchRoute(routes, { headers: { host: "other.local" }, url: "/v1/orders" } as never)).toBeUndefined();
  });

  test("refuses to bind 0.0.0.0", async () => {
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "0.0.0.0", port: 18999 };
    const server = new ProxyServer(cfg);
    await expect(server.start()).rejects.toMatchObject({ kind: KindProxy });
  });

  test("token endpoint rejects missing internal header", async () => {
    const tokens = new TokenManager(60_000, [{ name: "stub", fetch: async () => token() }]);
    const ep = new TokenEndpoint("127.0.0.1", 0, "s3cret", tokens);
    await ep.start();
    const port = ep.listenPort();
    expect(port).toBeGreaterThan(0);
    const denied = await fetch(`http://127.0.0.1:${port}/token`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/token`, { headers: { [INTERNAL_TOKEN_HEADER]: "s3cret" } });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.access_token).toBe("secret-token");
    expect(body.token_type).toBe("Bearer");
    await ep.stop();
  });

  test("proxy log lines omit Authorization", async () => {
    const upstream = createServer((_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const upAddr = upstream.address();
    const upPort = typeof upAddr === "object" && upAddr ? upAddr.port : 0;
    const reserved = createServer();
    await new Promise<void>((resolve) => {
      reserved.listen(0, "127.0.0.1", () => resolve());
    });
    const reservedAddr = reserved.address();
    const proxyPort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const logs = new LogManager(50, undefined, new Detector([], []), false, "", "px");
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "127.0.0.1", port: proxyPort };
    cfg.routes.push({
      name: "local",
      match: { host: "", path: "" },
      upstream: { url: `http://127.0.0.1:${upPort}` },
      auth: { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "" },
    });
    const server = new ProxyServer(cfg, undefined, logs);
    await server.start();
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/ping`, {
      headers: { Authorization: "Bearer secret-header-token" },
    });
    expect(resp.status).toBe(200);
    const messages = logs.query({}).map((ev) => ev.message).join("\n");
    expect(messages).toContain("GET /ping");
    expect(messages).toContain("route=local");
    expect(messages).toContain("duration=");
    expect(messages).not.toContain("Authorization");
    expect(messages).not.toContain("secret-header-token");
    await server.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  test("injects Bearer token for the configured route identity", async () => {
    let seenAuth = "";
    const upstream = createServer((req, res) => {
      seenAuth = String(req.headers.authorization ?? "");
      res.end("ok");
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const upAddr = upstream.address();
    const upPort = typeof upAddr === "object" && upAddr ? upAddr.port : 0;
    const reserved = createServer();
    await new Promise<void>((resolve) => {
      reserved.listen(0, "127.0.0.1", () => resolve());
    });
    const reservedAddr = reserved.address();
    const proxyPort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const tokens = new TokenManager(60_000, [
      { name: "stub", fetch: async (identity) => token({ accessToken: `tok-${identity}`, identity }) },
    ]);
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "127.0.0.1", port: proxyPort };
    cfg.routes.push({
      name: "iap",
      match: { host: "", path: "" },
      upstream: { url: `http://127.0.0.1:${upPort}` },
      auth: { type: "iap", identity: { type: "user", service_account: "" }, audience: "/projects/1/iap", service_account: "" },
    });
    const server = new ProxyServer(cfg, tokens);
    await server.start();
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/secure`);
    expect(resp.status).toBe(200);
    expect(seenAuth).toBe("Bearer tok-user");
    await server.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  test("mock IAP upstream accepts the injected identity token", async () => {
    const mock = await startMockIapServer("tok-user");
    const reserved = createServer();
    await new Promise<void>((resolve) => {
      reserved.listen(0, "127.0.0.1", () => resolve());
    });
    const reservedAddr = reserved.address();
    const proxyPort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const tokens = new TokenManager(60_000, [
      { name: "stub", fetch: async (identity) => token({ accessToken: `tok-${identity}`, identity }) },
    ]);
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "127.0.0.1", port: proxyPort };
    cfg.routes.push({
      name: "iap",
      match: { host: "", path: "" },
      upstream: { url: mock.url },
      auth: { type: "iap", identity: { type: "user", service_account: "" }, audience: "/projects/1/iap", service_account: "" },
    });
    const server = new ProxyServer(cfg, tokens);
    await server.start();
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/secure`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
    await server.stop();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });
});
