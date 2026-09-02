import { createServer } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config/types.ts";
import { startMockIapServer } from "./testdata/mock-iap-server.ts";
import { KindProxy } from "./errors.ts";
import { LogManager } from "./logs.ts";
import { INTERNAL_TOKEN_HEADER, matchRoute, ProxyServer, resolveProxyTarget, TokenEndpoint } from "./proxy.ts";
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

async function setupProxy(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upAddr = upstream.address();
  const upPort = typeof upAddr === "object" && upAddr ? upAddr.port : 0;
  const reserved = createServer();
  await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", () => resolve()));
  const reservedAddr = reserved.address();
  const proxyPort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
  await new Promise<void>((resolve) => reserved.close(() => resolve()));
  const cfg = defaultConfig().proxy;
  cfg.listen = { host: "127.0.0.1", port: proxyPort };
  cfg.routes.push({
    name: "route",
    match: { host: "", path: "" },
    upstream: { url: `http://127.0.0.1:${upPort}` },
    auth: { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "" },
  });
  const server = new ProxyServer(cfg);
  await server.start();
  return {
    upPort,
    proxyPort,
    close: async (): Promise<void> => {
      await server.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

describe("proxy", () => {
  test("resolveProxyTarget keeps the configured origin", () => {
    const base = "http://127.0.0.1:8000/api/";
    expect(resolveProxyTarget(base, "/ping").href).toBe("http://127.0.0.1:8000/ping");
    expect(resolveProxyTarget(base, "rel?q=1").href).toBe("http://127.0.0.1:8000/api/rel?q=1");
    expect(resolveProxyTarget(base, "http://evil.example/steal").href).toBe("http://127.0.0.1:8000/steal");
    expect(resolveProxyTarget(base, "//evil.example/steal").href).toBe("http://127.0.0.1:8000/steal");
    expect(resolveProxyTarget(base, "///evil.example").href).toBe("http://127.0.0.1:8000/");
  });

  test("failed upstream writes a plain 502 without the exception text", async () => {
    const reserved = createServer();
    await new Promise<void>((resolve) => {
      reserved.listen(0, "127.0.0.1", () => resolve());
    });
    const reservedAddr = reserved.address();
    const proxyPort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "127.0.0.1", port: proxyPort };
    cfg.routes.push({
      name: "down",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:1" },
      auth: { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "" },
    });
    const server = new ProxyServer(cfg);
    await server.start();
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/<img src=x onerror=alert(1)>`);
    expect(resp.status).toBe(502);
    expect(resp.headers.get("content-type")).toContain("text/plain");
    expect(await resp.text()).toBe("proxy error");
    await server.stop();
  });

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

  test("a negotiated gzip response is decompressed and its compressed-length headers stripped", async () => {
    const plaintext = "hello from a gzip-compressed upstream response, repeated to make compression worthwhile";
    const compressed = gzipSync(Buffer.from(plaintext));
    const { proxyPort, close } = await setupProxy((_req, res) => {
      // Mixed case on purpose: content-encoding must be parsed case-insensitively.
      res.setHeader("content-encoding", "GZIP");
      res.setHeader("content-length", String(compressed.length));
      res.end(compressed);
    });
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/gz`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBeNull();
    expect(resp.headers.get("content-length")).toBeNull();
    expect(await resp.text()).toBe(plaintext);
    await close();
  }, 10_000);

  test("a negotiated brotli response is decompressed and its compressed-length headers stripped", async () => {
    const plaintext = "hello from a brotli-compressed upstream response, repeated to make compression worthwhile";
    const compressed = brotliCompressSync(Buffer.from(plaintext));
    const { proxyPort, close } = await setupProxy((_req, res) => {
      res.setHeader("content-encoding", "br");
      res.setHeader("content-length", String(compressed.length));
      res.end(compressed);
    });
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/br`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBeNull();
    expect(resp.headers.get("content-length")).toBeNull();
    expect(await resp.text()).toBe(plaintext);
    await close();
  }, 10_000);

  test("an unexpected content-encoding is forwarded unchanged, headers and bytes alike", async () => {
    const raw = Buffer.from("not actually compressed, just labeled that way");
    const { proxyPort, close } = await setupProxy((_req, res) => {
      res.setHeader("content-encoding", "x-custom");
      res.setHeader("content-length", String(raw.length));
      res.end(raw);
    });
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/x`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBe("x-custom");
    expect(resp.headers.get("content-length")).toBe(String(raw.length));
    expect(await resp.text()).toBe(raw.toString());
    await close();
  }, 10_000);

  test("forwards a clean Host, pins accept-encoding, and adds X-Forwarded-* headers", async () => {
    const seen: Record<string, string> = {};
    const { upPort, proxyPort, close } = await setupProxy((req, res) => {
      seen.host = String(req.headers.host ?? "");
      seen.xff = String(req.headers["x-forwarded-for"] ?? "");
      seen.xfh = String(req.headers["x-forwarded-host"] ?? "");
      seen.xfp = String(req.headers["x-forwarded-proto"] ?? "");
      seen.ae = String(req.headers["accept-encoding"] ?? "");
      res.end("ok");
    });
    // The client deliberately sends something other than what we negotiate,
    // to prove the proxy overrides it rather than forwarding it verbatim.
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/hdr`, { headers: { "accept-encoding": "identity" } });
    expect(resp.status).toBe(200);
    expect(seen.host).toBe(`127.0.0.1:${upPort}`);
    expect(seen.xff).toMatch(/127\.0\.0\.1/);
    expect(seen.xfh).toBe(`127.0.0.1:${proxyPort}`);
    expect(seen.xfp).toBe("http");
    expect(seen.ae).toBe("gzip, deflate, br");
    await close();
  }, 10_000);
});
