import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyLlmSource, type RouteAuthConfig, type RouteConfig } from "../../domain/config/types.ts";
import { LlmCallManager } from "../llm/store.ts";
import { ProxyCaptureSink } from "../llm/proxy-capture.ts";
import { TrafficCallRing } from "../traffic/store.ts";
import { ProxyTrafficSink } from "../traffic/capture.ts";
import type { LlmCaptureBegin, LlmCaptureRecorder, LlmCaptureSink } from "../../ports/llm-capture.ts";
import { startMockIapServer } from "../google/testdata/mock-iap-server.ts";
import { type CredentialRecord, type CredentialStore } from "../storage/credentials.ts";
import { KindProxy } from "../../shared/errors.ts";
import { Bus, TokenRefreshFailed, TokenRefreshed } from "../../shared/events.ts";
import { formatBodySummary } from "../../domain/logs/logs.ts";
import { LogManager } from "../storage/logs.ts";
import { forwardedRequestUrl, injectIdentityHeaders, INTERNAL_TOKEN_HEADER, matchRoute, ProxyServer, proxyUpgradeRequest, REQUEST_ID_HEADER, RequestLog, resolveProxyTarget, TokenEndpoint, type ProxyRequestRecord } from "./proxy.ts";
import { Detector } from "../secrets/detector.ts";
import { TokenManager, type AccessToken, type TokenProvider } from "../google/token.ts";

// TokenManager defaults to the real OS keychain/file store when none is
// given. Several cases below deliberately reuse the same identity+audience
// to test caching/refresh, so without an isolated store they'd read back
// whatever an earlier test (or an earlier run) already cached there —
// exactly the kind of stale-cache confusion this whole session started
// from. Give each such test its own throwaway in-memory store instead.
function memoryStore(): CredentialStore {
  const records = new Map<string, CredentialRecord>();
  return {
    backend: "file",
    get: async (key) => records.get(key),
    set: async (key, record) => {
      records.set(key, record);
    },
    delete: async (key) => {
      records.delete(key);
    },
    list: async () =>
      [...records.entries()].map(([key, rec]) => ({
        key,
        identity: rec.identity,
        audience: rec.audience,
        scopes: rec.scopes,
        expires_at: rec.expiresAt,
        valid: Date.parse(rec.expiresAt) - Date.now() > 0,
      })),
  };
}

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

const NONE_AUTH: RouteAuthConfig = { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "", client_id: "", client_secret: "" };

async function setupProxy(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  opts: { auth?: RouteAuthConfig; tokens?: TokenManager; logs?: LogManager; bus?: Bus; responseHeaders?: Record<string, string>; timeout?: RouteConfig["timeout"] } = {},
) {
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
    auth: opts.auth ?? NONE_AUTH,
    response_headers: opts.responseHeaders,
    timeout: opts.timeout,
  });
  const server = new ProxyServer(cfg, opts.tokens, opts.logs, opts.bus);
  await server.start();
  return {
    upPort,
    proxyPort,
    server,
    close: async (): Promise<void> => {
      await server.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

// Captures every header the upstream actually receives, plus the request
// method/URL — the thing worth asserting on is what a request really
// carried, not just that the proxy returned some status code.
async function setupHeaderCapture(auth: RouteAuthConfig, tokens?: TokenManager, respond: (res: import("node:http").ServerResponse) => void = (res) => res.end("ok")) {
  const seen: { headers: Record<string, string>; method: string; url: string } = { headers: {}, method: "", url: "" };
  const { proxyPort, close, server } = await setupProxy(
    (req, res) => {
      seen.method = req.method ?? "";
      seen.url = req.url ?? "";
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          seen.headers[key] = value;
        }
      }
      respond(res);
    },
    { auth, tokens },
  );
  return { proxyPort, close, server, seen };
}

describe("proxy", () => {
  test("resolves a service-reference upstream at request time and follows a port change", async () => {
    const makeUpstream = async (body: string): Promise<{ server: ReturnType<typeof createServer>; port: number }> => {
      const s = createServer((_req, res) => res.end(body));
      await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
      const addr = s.address();
      return { server: s, port: typeof addr === "object" && addr ? addr.port : 0 };
    };
    const a = await makeUpstream("from-A");
    const b = await makeUpstream("from-B");
    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", () => resolve()));
    const reservedAddr = reserved.address();
    const proxyPort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));

    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "127.0.0.1", port: proxyPort };
    cfg.routes.push({ name: "api", match: { host: "", path: "" }, upstream: { url: "", service: "api", port: "http" }, auth: NONE_AUTH });

    // A mutable resolver stands in for the daemon's live assigned-ports map.
    let current: number | undefined = a.port;
    const server = new ProxyServer(cfg, undefined, undefined, undefined, undefined, [], (svc, port) => (svc === "api" && port === "http" ? current : undefined));
    await server.start();
    try {
      const first = await fetch(`http://127.0.0.1:${proxyPort}/`);
      expect(await first.text()).toBe("from-A");
      // The service "restarts" on a different port; no proxy reload happens.
      current = b.port;
      const second = await fetch(`http://127.0.0.1:${proxyPort}/`);
      expect(await second.text()).toBe("from-B");
      // Service down: unresolved port surfaces as a 502.
      current = undefined;
      const down = await fetch(`http://127.0.0.1:${proxyPort}/`);
      expect(down.status).toBe(502);
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => a.server.close(() => resolve()));
      await new Promise<void>((resolve) => b.server.close(() => resolve()));
    }
  });

  test("injects auth.headers alongside Authorization, substituting ${token}", async () => {
    const provider: TokenProvider = { name: "stub", fetch: async () => token({ accessToken: "ID-TOKEN" }) };
    const tokens = new TokenManager(60_000, [provider], undefined, memoryStore());
    const route: RouteConfig = {
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:1" },
      auth: { ...NONE_AUTH, type: "service_account", identity: { type: "service_account", service_account: "sa@x.iam.gserviceaccount.com" }, headers: { "identity-token": "${token}", "x-static": "literal" } },
    };
    const headers: Record<string, string> = {};
    await injectIdentityHeaders(route, headers, tokens);
    expect(headers.authorization).toBe("Bearer ID-TOKEN");
    expect(headers["identity-token"]).toBe("ID-TOKEN");
    expect(headers["x-static"]).toBe("literal");
  });

  test("suppress_authorization skips Authorization and still substitutes ${token} in auth.headers", async () => {
    const provider: TokenProvider = { name: "stub", fetch: async () => token({ accessToken: "ID-TOKEN" }) };
    const tokens = new TokenManager(60_000, [provider], undefined, memoryStore());
    const route: RouteConfig = {
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:1" },
      auth: {
        ...NONE_AUTH,
        type: "iap",
        audience: "/projects/1/iap",
        suppress_authorization: true,
        headers: { "Proxy-Authorization": "Bearer ${token}", "x-static": "literal" },
      },
    };
    const headers: Record<string, string> = { authorization: "Bearer workspace-oauth" };
    await injectIdentityHeaders(route, headers, tokens);
    expect(headers.authorization).toBe("Bearer workspace-oauth");
    expect(headers["Proxy-Authorization"]).toBe("Bearer ID-TOKEN");
    expect(headers["x-static"]).toBe("literal");
  });

  test("injects configured response_headers, overriding the upstream's", async () => {
    const { proxyPort, close } = await setupProxy(
      (_req, res) => {
        res.setHeader("access-control-allow-origin", "http://upstream-value");
        res.end("ok");
      },
      { responseHeaders: { "Access-Control-Allow-Origin": "*" } },
    );
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/`);
      expect(await resp.text()).toBe("ok");
      expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await close();
    }
  });

  test("answers a CORS preflight directly with response_headers, not forwarding", async () => {
    let upstreamHit = false;
    const { proxyPort, close } = await setupProxy(
      (_req, res) => {
        upstreamHit = true;
        res.end("ok");
      },
      { responseHeaders: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } },
    );
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/`, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", Origin: "http://app" } });
      expect(resp.status).toBe(204);
      expect(resp.headers.get("access-control-allow-origin")).toBe("*");
      expect(resp.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
      await resp.arrayBuffer();
      expect(upstreamHit).toBe(false);
    } finally {
      await close();
    }
  });

  test("serves a cached http recipe and answers CORS preflight without fetching", async () => {
    let fetches = 0;
    const recipes = {
      ensure: async () => {
        fetches += 1;
        return { status: 200, body: "{\"access_token\":\"abc\"}", contentType: "application/json", values: { body: "{\"access_token\":\"abc\"}", status: "200", token: "abc" } };
      },
      snapshot: () => undefined,
      start: () => {},
      stop: () => {},
      reset: () => {},
    };
    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", () => resolve()));
    const reservedAddr = reserved.address();
    const proxyPort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "127.0.0.1", port: proxyPort };
    cfg.routes.push({
      name: "login.local",
      match: { host: "", path: "" },
      upstream: { url: "", recipe: "login" },
      auth: NONE_AUTH,
      response_headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
    });
    const server = new ProxyServer(cfg, undefined, undefined, undefined, undefined, [], undefined, undefined, recipes);
    await server.start();
    try {
      const preflight = await fetch(`http://127.0.0.1:${proxyPort}/`, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET", Origin: "http://app" } });
      expect(preflight.status).toBe(204);
      expect(fetches).toBe(0);
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("{\"access_token\":\"abc\"}");
      expect(resp.headers.get("access-control-allow-origin")).toBe("*");
      expect(fetches).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("forwards a non-preflight OPTIONS to the upstream (still injecting headers)", async () => {
    let upstreamHit = false;
    const { proxyPort, close } = await setupProxy(
      (_req, res) => {
        upstreamHit = true;
        res.statusCode = 200;
        res.end("from-upstream");
      },
      { responseHeaders: { "Access-Control-Allow-Origin": "*" } },
    );
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/`, { method: "OPTIONS" });
      expect(await resp.text()).toBe("from-upstream");
      expect(upstreamHit).toBe(true);
      expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await close();
    }
  });

  test("proxies WebSocket upgrades, round-trips bytes, and closes live sockets on stop", async () => {
    const upstream = createServer();
    let seenAuthorization = "";
    upstream.on("upgrade", (req, socket, head) => {
      seenAuthorization = String(req.headers.authorization ?? "");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      if (head.length > 0) socket.write(head);
      socket.on("data", (chunk) => socket.write(chunk));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upAddr = upstream.address();
    const upPort = typeof upAddr === "object" && upAddr ? upAddr.port : 0;

    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
    const reservedAddr = reserved.address();
    const proxyPort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "127.0.0.1", port: proxyPort };
    cfg.routes.push({
      name: "ws",
      match: { host: "", path: "/socket" },
      upstream: { url: `http://127.0.0.1:${upPort}` },
      auth: { type: "iap", identity: { type: "user", service_account: "" }, audience: "/projects/1/iap", service_account: "", client_id: "", client_secret: "" },
    });
    const tokens = new TokenManager(60_000, [{ name: "stub", fetch: async () => token({ accessToken: "ws-token" }) }]);
    const proxy = new ProxyServer(cfg, tokens);
    await proxy.start();

    const client = connect(proxyPort, "127.0.0.1");
    let received = "";
    await new Promise<void>((resolve, reject) => {
      client.once("error", reject);
      client.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("101 Switching Protocols") && !received.includes("round-trip")) client.write("round-trip");
        if (received.includes("round-trip")) resolve();
      });
      client.write("GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    expect(received).toContain("101 Switching Protocols");
    expect(received).toContain("round-trip");
    expect(seenAuthorization).toBe("Bearer ws-token");
    expect(proxy.stats().recent[0]?.status).toBe(101);

    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    await proxy.stop();
    await closed;
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  test("proxies HTTPS WebSocket upgrades", async () => {
    const testdata = join(dirname(fileURLToPath(import.meta.url)), "testdata");
    const key = readFileSync(join(testdata, "localhost-key.pem"));
    const cert = readFileSync(join(testdata, "localhost-cert.pem"));
    const upstream = createHttpsServer({ key, cert });
    upstream.on("upgrade", (_req, socket, head) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      if (head.length > 0) socket.write(head);
      socket.on("data", (chunk) => socket.write(chunk));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upAddr = upstream.address();
    const upPort = typeof upAddr === "object" && upAddr ? upAddr.port : 0;

    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
    const reservedAddr = reserved.address();
    const proxyPort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "127.0.0.1", port: proxyPort };
    cfg.routes.push({
      name: "wss",
      match: { host: "", path: "/socket" },
      upstream: { url: `https://127.0.0.1:${upPort}` },
      auth: NONE_AUTH,
    });
    const proxy = new ProxyServer(cfg);
    await proxy.start();
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const client = connect(proxyPort, "127.0.0.1");
      let received = "";
      await new Promise<void>((resolve, reject) => {
        client.once("error", reject);
        client.on("data", (chunk) => {
          received += chunk.toString();
          if (received.includes("101 Switching Protocols") && !received.includes("round-trip")) client.write("round-trip");
          if (received.includes("round-trip")) resolve();
        });
        client.write("GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      });
      expect(received).toContain("101 Switching Protocols");
      expect(received).toContain("round-trip");
    } finally {
      if (previousTls === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
      }
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("rejects unmatched WebSocket upgrades without hanging", async () => {
    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
    const addr = reserved.address();
    const proxyPort = typeof addr === "object" && addr ? addr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "127.0.0.1", port: proxyPort };
    const proxy = new ProxyServer(cfg);
    await proxy.start();
    const response = await new Promise<string>((resolve, reject) => {
      const client = connect(proxyPort, "127.0.0.1");
      let data = "";
      client.once("error", reject);
      client.on("data", (chunk) => (data += chunk.toString()));
      client.once("close", () => resolve(data));
      client.write("GET /missing HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    expect(response).toContain("404 Not Found");
    expect(proxy.stats().recent[0]?.status).toBe(404);
    await proxy.stop();
  });

  test("resolveProxyTarget keeps the configured origin", () => {
    const base = "http://127.0.0.1:8000/api/";
    expect(resolveProxyTarget(base, "/ping").href).toBe("http://127.0.0.1:8000/ping");
    expect(resolveProxyTarget(base, "rel?q=1").href).toBe("http://127.0.0.1:8000/api/rel?q=1");
    expect(resolveProxyTarget(base, "http://evil.example/steal").href).toBe("http://127.0.0.1:8000/steal");
    expect(resolveProxyTarget(base, "//evil.example/steal").href).toBe("http://127.0.0.1:8000/steal");
    expect(resolveProxyTarget(base, "///evil.example").href).toBe("http://127.0.0.1:8000/");
  });

  test("strip_prefix rewrites the forwarded path and preserves the query", () => {
    const route: RouteConfig = {
      name: "svc",
      match: { host: "", path: "/my-service" },
      upstream: { url: "http://127.0.0.1:8000" },
      auth: NONE_AUTH,
      strip_prefix: true,
    };
    expect(forwardedRequestUrl(route, "/my-service")).toBe("/");
    expect(forwardedRequestUrl(route, "/my-service/foo")).toBe("/foo");
    expect(forwardedRequestUrl(route, "/my-service/foo?q=1")).toBe("/foo?q=1");
    expect(forwardedRequestUrl(route, "/my-service?q=1")).toBe("/?q=1");
    expect(resolveProxyTarget("http://127.0.0.1:8000", forwardedRequestUrl(route, "/my-service")).href).toBe("http://127.0.0.1:8000/");
    expect(resolveProxyTarget("http://127.0.0.1:8000", forwardedRequestUrl(route, "/my-service/foo?q=1")).href).toBe("http://127.0.0.1:8000/foo?q=1");
    expect(forwardedRequestUrl({ ...route, strip_prefix: false }, "/my-service/foo")).toBe("/my-service/foo");
  });

  test("proxyUpgradeRequest uses https.request for https upstreams", () => {
    expect(proxyUpgradeRequest(new URL("http://127.0.0.1:8000/"))).toBe(httpRequest);
    expect(proxyUpgradeRequest(new URL("https://127.0.0.1:8000/"))).toBe(httpsRequest);
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
      auth: { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "", client_id: "", client_secret: "" },
    });
    const server = new ProxyServer(cfg);
    await server.start();
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/<img src=x onerror=alert(1)>`);
    expect(resp.status).toBe(502);
    expect(resp.headers.get("content-type")).toContain("text/plain");
    expect(await resp.text()).toBe("proxy error");
    await server.stop();
  });

  test("replaceConfig updates routes without closing the HTTP listen socket", async () => {
    const { proxyPort, server, close } = await setupProxy((_req, res) => res.end("ok"));
    try {
      const first = await fetch(`http://127.0.0.1:${proxyPort}/v1`);
      expect(first.status).toBe(200);
      const next = defaultConfig().proxy;
      next.listen = { host: "127.0.0.1", port: proxyPort };
      next.routes.push({
        name: "v2-only",
        match: { host: "", path: "/v2" },
        upstream: { url: `http://127.0.0.1:9` },
        auth: NONE_AUTH,
      });
      server.replaceConfig(next);
      expect(server.isRunning()).toBe(true);
      expect(server.address()).toBe(`127.0.0.1:${proxyPort}`);
      const miss = await fetch(`http://127.0.0.1:${proxyPort}/v1`);
      expect(miss.status).toBe(404);
      const hit = await fetch(`http://127.0.0.1:${proxyPort}/v2`);
      expect(hit.status).toBe(502);
    } finally {
      await close();
    }
  });

  test("total_ms aborts a slow upstream with 504 and increments errors", async () => {
    const { proxyPort, server, close } = await setupProxy((_req, _res) => {
      /* hang until the proxy aborts */
    }, { timeout: { total_ms: 50 } });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/slow`);
      expect(resp.status).toBe(504);
      expect(await resp.text()).toBe("gateway timeout");
      for (let i = 0; i < 50 && server.stats().total === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(server.stats().errors).toBe(1);
      expect(server.stats().recent[0]?.error).toBe("proxy total timeout");
    } finally {
      await close();
    }
  });

  test("idle_ms aborts when the upstream never sends a chunk", async () => {
    const { proxyPort, server, close } = await setupProxy((_req, _res) => {
      /* hang — no headers, no body */
    }, { timeout: { idle_ms: 50 } });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/idle`);
      expect(resp.status).toBe(504);
      expect(await resp.text()).toBe("gateway timeout");
      for (let i = 0; i < 50 && server.stats().total === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(server.stats().errors).toBe(1);
      expect(server.stats().recent[0]?.error).toBe("proxy idle timeout");
    } finally {
      await close();
    }
  });

  test("idle_ms disconnects when response chunks stall after headers", async () => {
    const { proxyPort, server, close } = await setupProxy((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("ping");
    }, { timeout: { idle_ms: 50 } });
    try {
      await expect(fetch(`http://127.0.0.1:${proxyPort}/stall`).then((resp) => resp.text())).rejects.toThrow(/socket connection was closed|ECONNRESET/);
      for (let i = 0; i < 50 && server.stats().total === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(server.stats().errors).toBeGreaterThanOrEqual(1);
      expect(server.stats().recent.some((row) => row.error === "proxy idle timeout")).toBe(true);
    } finally {
      await close();
    }
  });

  test("idle_ms aborts a stalled request body upload with 504", async () => {
    const { proxyPort, server, close } = await setupProxy((req, res) => {
      req.on("data", () => {});
      req.on("end", () => res.end("late"));
    }, { timeout: { idle_ms: 50 } });
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
      });
      const init = { method: "POST", headers: { "content-type": "text/plain" }, body: stream, duplex: "half" } as unknown as RequestInit;
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/upload`, init);
      expect(resp.status).toBe(504);
      expect(await resp.text()).toBe("gateway timeout");
      for (let i = 0; i < 50 && server.stats().total === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(server.stats().recent[0]?.error).toBe("proxy idle timeout");
    } finally {
      await close();
    }
  });

  test("missing timeout still allows a long stream", async () => {
    const { proxyPort, close } = await setupProxy((_req, res) => {
      setTimeout(() => res.end("ok"), 200);
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/slow-ok`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("ok");
    } finally {
      await close();
    }
  });

  test("matchRoute uses host and path prefix", () => {
    const routes = defaultConfig().proxy.routes;
    routes.push({
      name: "billing",
      match: { host: "billing.local", path: "/v1" },
      upstream: { url: "https://example.com" },
      auth: { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "", client_id: "", client_secret: "" },
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

  test("refuses to bind ::", async () => {
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "::", port: 18999 };
    const server = new ProxyServer(cfg);
    await expect(server.start()).rejects.toMatchObject({ kind: KindProxy });
  });

  test("token endpoint rejects missing internal header", async () => {
    const tokens = new TokenManager(60_000, [{ name: "stub", fetch: async () => token() }]);
    const ep = new TokenEndpoint("127.0.0.1", 0, "s3cret", tokens, [{ identity: "user", audience: "" }]);
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

  // The gap the demo-platform token-watch loop (invoices-worker/main.py)
  // depends on: the identity/audience query params it sends are URL-encoded
  // (a "sa:...@...iam.gserviceaccount.com" identity and a "https://..."
  // audience both contain characters that need percent-encoding), and
  // nothing previously proved TokenEndpoint.serve() decodes them back to the
  // exact strings a real caller sent rather than a truncated or mangled one.
  test("token endpoint decodes identity/audience query params and forwards them exactly", async () => {
    const calls: { identity: string; audience: string }[] = [];
    const tokens = new TokenManager(
      60_000,
      [
        {
          name: "stub",
          fetch: async (identity, audience) => {
            calls.push({ identity, audience });
            return token({ identity, audience });
          },
        },
      ],
      undefined,
      memoryStore(),
    );
    const identity = "sa:test-389@company-dev.iam.gserviceaccount.com";
    const audience = "https://invoices-worker.local";
    const ep = new TokenEndpoint("127.0.0.1", 0, "s3cret", tokens, [{ identity, audience }]);
    await ep.start();
    const port = ep.listenPort();
    const query = new URLSearchParams({ identity, audience }).toString();
    const resp = await fetch(`http://127.0.0.1:${port}/token?${query}`, { headers: { [INTERNAL_TOKEN_HEADER]: "s3cret" } });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.identity).toBe(identity);
    expect(calls).toEqual([{ identity, audience }]);
    await ep.stop();
  });

  test("token endpoint refuses an identity/audience pair that is not declared", async () => {
    const calls: { identity: string; audience: string }[] = [];
    const tokens = new TokenManager(
      60_000,
      [
        {
          name: "stub",
          fetch: async (identity, audience) => {
            calls.push({ identity, audience });
            return token({ identity, audience });
          },
        },
      ],
      undefined,
      memoryStore(),
    );
    const identity = "sa:test-389@company-dev.iam.gserviceaccount.com";
    const audience = "https://invoices-worker.local";
    const ep = new TokenEndpoint("127.0.0.1", 0, "s3cret", tokens, [{ identity, audience }]);
    await ep.start();
    const port = ep.listenPort();
    const denied = await fetch(`http://127.0.0.1:${port}/token?identity=user&audience=${encodeURIComponent(audience)}`, {
      headers: { [INTERNAL_TOKEN_HEADER]: "s3cret" },
    });
    expect(denied.status).toBe(403);
    expect(calls).toEqual([]);
    await ep.stop();
  });

  test("token endpoint returns 429 when Google minting is rate limited", async () => {
    const tokens = new TokenManager(
      60_000,
      [
        {
          name: "stub",
          fetch: async () => token({ expiresAt: new Date(Date.now() - 1_000) }),
        },
      ],
      undefined,
      memoryStore(),
      undefined,
      1,
    );
    const ep = new TokenEndpoint("127.0.0.1", 0, "s3cret", tokens, [{ identity: "user", audience: "" }]);
    await ep.start();
    const port = ep.listenPort();
    const headers = { [INTERNAL_TOKEN_HEADER]: "s3cret" };
    const first = await fetch(`http://127.0.0.1:${port}/token`, { headers });
    expect(first.status).toBe(200);
    const limited = await fetch(`http://127.0.0.1:${port}/token`, { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
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
      auth: { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "", client_id: "", client_secret: "" },
    });
    const server = new ProxyServer(cfg, undefined, logs);
    await server.start();
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/ping`, {
      headers: { Authorization: "Bearer secret-header-token" },
    });
    expect(resp.status).toBe(200);
    const messages = logs.query({}).map((ev) => formatBodySummary(ev)).join("\n");
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
      auth: { type: "iap", identity: { type: "user", service_account: "" }, audience: "/projects/1/iap", service_account: "", client_id: "", client_secret: "" },
    });
    const server = new ProxyServer(cfg, tokens);
    await server.start();
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/secure`);
    expect(resp.status).toBe(200);
    expect(seenAuth).toBe("Bearer tok-user");
    await server.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  test("forwards caller Authorization and injects Proxy-Authorization when suppress_authorization is set", async () => {
    const provider: TokenProvider = { name: "stub", fetch: async () => token({ accessToken: "IAP-TOKEN" }) };
    const tokens = new TokenManager(60_000, [provider], undefined, memoryStore());
    const { proxyPort, close, seen } = await setupHeaderCapture(
      {
        type: "iap",
        identity: { type: "user", service_account: "" },
        audience: "/projects/1/iap",
        service_account: "",
        client_id: "",
        client_secret: "",
        suppress_authorization: true,
        headers: { "Proxy-Authorization": "Bearer ${token}" },
      },
      tokens,
    );
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
        headers: { Authorization: "Bearer workspace-oauth" },
      });
      expect(resp.status).toBe(200);
      expect(seen.headers.authorization).toBe("Bearer workspace-oauth");
      expect(seen.headers["proxy-authorization"]).toBe("Bearer IAP-TOKEN");
    } finally {
      await close();
    }
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
      auth: { type: "iap", identity: { type: "user", service_account: "" }, audience: "/projects/1/iap", service_account: "", client_id: "", client_secret: "" },
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

describe("proxy identity and token wiring", () => {
  test("a plain service_account route (no IAP) mints with the sa: identity and an empty audience", async () => {
    const calls: { identity: string; audience: string }[] = [];
    const tokens = new TokenManager(
      60_000,
      [
        {
          name: "stub",
          fetch: async (identity, audience) => {
            calls.push({ identity, audience });
            return token({ accessToken: `tok-${identity}`, identity, audience });
          },
        },
      ],
      undefined,
      memoryStore(),
    );
    const auth: RouteAuthConfig = {
      type: "service_account",
      identity: { type: "service_account", service_account: "worker@example.com" },
      audience: "",
      service_account: "",
      client_id: "",
      client_secret: "",
    };
    const { proxyPort, close, seen } = await setupHeaderCapture(auth, tokens);
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/api`);
    expect(resp.status).toBe(200);
    expect(seen.headers.authorization).toBe("Bearer tok-sa:worker@example.com");
    expect(calls).toEqual([{ identity: "sa:worker@example.com", audience: "" }]);
    await close();
  });

  // The gap this session found: no existing test exercised IAP with a
  // service_account identity — the user's actual demo-platform route shape
  // (auth.type: iap, identity.type: service_account). This proves the
  // request that reaches the upstream carries a Bearer token minted for the
  // impersonated sa: identity against the route's real IAP audience, not
  // some other (identity, audience) pair.
  test("an IAP route with a service_account identity mints the impersonated identity against the route's real audience", async () => {
    const calls: { identity: string; audience: string }[] = [];
    const tokens = new TokenManager(
      60_000,
      [
        {
          name: "stub",
          fetch: async (identity, audience) => {
            calls.push({ identity, audience });
            return token({ accessToken: `tok-${identity}-${audience}`, identity, audience });
          },
        },
      ],
      undefined,
      memoryStore(),
    );
    const auth: RouteAuthConfig = {
      type: "iap",
      identity: { type: "service_account", service_account: "test-389@example.com" },
      audience: "https://invoices-worker.local",
      service_account: "",
      client_id: "",
      client_secret: "",
    };
    const { proxyPort, close, seen } = await setupHeaderCapture(auth, tokens);
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/invoices`);
    expect(resp.status).toBe(200);
    expect(seen.headers.authorization).toBe("Bearer tok-sa:test-389@example.com-https://invoices-worker.local");
    expect(calls).toEqual([{ identity: "sa:test-389@example.com", audience: "https://invoices-worker.local" }]);
    await close();
  });

  test("an IAP user route with client_id mints using that OAuth client", async () => {
    const calls: { identity: string; audience: string; clientId?: string }[] = [];
    const tokens = new TokenManager(
      60_000,
      [
        {
          name: "stub",
          fetch: async (identity, audience, _scopes, oauth) => {
            calls.push({ identity, audience, clientId: oauth?.clientId });
            return token({ accessToken: "tok-custom", identity, audience });
          },
        },
      ],
      undefined,
      memoryStore(),
    );
    const auth: RouteAuthConfig = {
      type: "iap",
      identity: { type: "user", service_account: "" },
      audience: "/projects/1/iap",
      service_account: "",
      client_id: "desktop.apps.googleusercontent.com",
      client_secret: "local-secret",
    };
    const { proxyPort, close, seen } = await setupHeaderCapture(auth, tokens);
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/secure`);
    expect(resp.status).toBe(200);
    expect(seen.headers.authorization).toBe("Bearer tok-custom");
    expect(calls).toEqual([{ identity: "user", audience: "/projects/1/iap", clientId: "desktop.apps.googleusercontent.com" }]);
    await close();
  });

  test("repeated requests within the token's validity window reuse the cached token", async () => {
    let calls = 0;
    const tokens = new TokenManager(
      60_000,
      [
        {
          name: "stub",
          fetch: async (identity, audience) => {
            calls += 1;
            return token({ accessToken: `tok-${calls}`, identity, audience, expiresAt: new Date(Date.now() + 10 * 60_000) });
          },
        },
      ],
      undefined,
      memoryStore(),
    );
    const auth: RouteAuthConfig = {
      type: "iap",
      identity: { type: "service_account", service_account: "worker@example.com" },
      audience: "https://worker.local",
      service_account: "",
      client_id: "",
      client_secret: "",
    };
    const { proxyPort, close, seen } = await setupHeaderCapture(auth, tokens);
    const first = await fetch(`http://127.0.0.1:${proxyPort}/one`);
    const firstAuth = seen.headers.authorization;
    const second = await fetch(`http://127.0.0.1:${proxyPort}/two`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(seen.headers.authorization).toBe(firstAuth);
    expect(calls).toBe(1);
    await close();
  });

  test("a token within the refresh threshold is re-minted on the next request", async () => {
    let calls = 0;
    const tokens = new TokenManager(
      60_000,
      [
        {
          name: "stub",
          fetch: async (identity, audience) => {
            calls += 1;
            // 30s of real life left is inside the 60s threshold above, so the
            // very next .get() must treat this as due for refresh.
            return token({ accessToken: `tok-${calls}`, identity, audience, expiresAt: new Date(Date.now() + 30_000) });
          },
        },
      ],
      undefined,
      memoryStore(),
    );
    const auth: RouteAuthConfig = {
      type: "iap",
      identity: { type: "service_account", service_account: "worker@example.com" },
      audience: "https://worker.local",
      service_account: "",
      client_id: "",
      client_secret: "",
    };
    const { proxyPort, close, seen } = await setupHeaderCapture(auth, tokens);
    await fetch(`http://127.0.0.1:${proxyPort}/one`);
    const firstAuth = seen.headers.authorization;
    await fetch(`http://127.0.0.1:${proxyPort}/two`);
    expect(seen.headers.authorization).not.toBe(firstAuth);
    expect(calls).toBe(2);
    await close();
  });

  test("a failed mint returns a generic 502 and publishes TokenRefreshFailed, never the underlying error text", async () => {
    const bus = new Bus(64);
    const seenEvents: string[] = [];
    bus.subscribe((ev) => seenEvents.push(ev.type), [TokenRefreshFailed, TokenRefreshed]);
    // TokenManager only publishes to the bus it was constructed with — a
    // ProxyServer given a different bus reference wouldn't see these events,
    // so this has to be the same object passed to setupProxy below.
    const tokens = new TokenManager(
      60_000,
      [
        {
          name: "stub",
          fetch: async () => {
            throw new Error("permission denied: caller lacks roles/iam.serviceAccountTokenCreator");
          },
        },
      ],
      bus,
      memoryStore(),
    );
    const auth: RouteAuthConfig = {
      type: "iap",
      identity: { type: "service_account", service_account: "worker@example.com" },
      audience: "https://worker.local",
      service_account: "",
      client_id: "",
      client_secret: "",
    };
    const { proxyPort, close } = await setupProxy((_req, res) => res.end("unreachable"), { auth, tokens, bus });
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/secure`);
    expect(resp.status).toBe(502);
    expect(await resp.text()).toBe("proxy error");
    expect(seenEvents).toEqual([TokenRefreshFailed]);
    await close();
  });

  test("echoes X-Devctl-Request-Id back to the caller, generating one when absent", async () => {
    const { proxyPort, close } = await setupProxy((_req, res) => res.end("ok"));
    const withId = await fetch(`http://127.0.0.1:${proxyPort}/a`, { headers: { [REQUEST_ID_HEADER]: "caller-supplied-id" } });
    expect(withId.headers.get(REQUEST_ID_HEADER)).toBe("caller-supplied-id");
    const withoutId = await fetch(`http://127.0.0.1:${proxyPort}/b`);
    expect(withoutId.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
    expect(withoutId.headers.get(REQUEST_ID_HEADER)).not.toBe("caller-supplied-id");
    expect(withoutId.headers.get(REQUEST_ID_HEADER)).toHaveLength(32);
    expect(withoutId.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(withId.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    await close();
  });

  test("stats() holds recent requests newest-first, including ones with no matching route", async () => {
    const { proxyPort, close, server } = await setupProxy((_req, res) => res.end("ok"));
    await fetch(`http://127.0.0.1:${proxyPort}/first`);
    await fetch(`http://127.0.0.1:${proxyPort}/second`);
    const stats = server.stats();
    expect(stats.total).toBe(2);
    expect(stats.errors).toBe(0);
    expect(stats.recent[0]?.path).toBe("/second");
    expect(stats.recent[1]?.path).toBe("/first");
    await close();

    const cfg = defaultConfig().proxy;
    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", () => resolve()));
    const reservedAddr = reserved.address();
    const noRoutePort = typeof reservedAddr === "object" && reservedAddr ? reservedAddr.port : 0;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    cfg.listen = { host: "127.0.0.1", port: noRoutePort };
    const noRouteServer = new ProxyServer(cfg);
    await noRouteServer.start();
    const resp = await fetch(`http://127.0.0.1:${noRoutePort}/nowhere`);
    expect(resp.status).toBe(404);
    const noRouteStats = noRouteServer.stats();
    expect(noRouteStats.total).toBe(1);
    expect(noRouteStats.errors).toBe(1);
    expect(noRouteStats.recent[0]?.route).toBe("");
    expect(noRouteStats.recent[0]?.status).toBe(404);
    await noRouteServer.stop();
  });
});

describe("RequestLog", () => {
  function rec(status: number, error?: string): ProxyRequestRecord {
    return {
      timestamp: new Date().toISOString(),
      requestId: "r",
      method: "GET",
      path: "/",
      route: "x",
      identity: "",
      status,
      durationMs: 1,
      error,
    };
  }

  test("stats().total and errors keep growing after the recent ring fills", () => {
    const log = new RequestLog(2);
    log.record(rec(200));
    log.record(rec(500));
    log.record(rec(200));
    log.record(rec(404, "missing"));
    const stats = log.stats();
    expect(stats.total).toBe(4);
    expect(stats.errors).toBe(2);
    expect(stats.recent).toHaveLength(2);
    expect(stats.recent[0]?.status).toBe(404);
    expect(stats.recent[1]?.status).toBe(200);
  });
});

async function reservePort(): Promise<number> {
  const reserved = createServer();
  await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", () => resolve()));
  const addr = reserved.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise<void>((resolve) => reserved.close(() => resolve()));
  return port;
}

async function waitUntil(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!pred() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("proxy LLM capture", () => {
  // Builds a proxy with a capture sink and a single route "route". `routeName`
  // controls which route the proxy source tags — point it elsewhere to model an
  // untagged route. `upstreamUrl` overrides the upstream (e.g. a dead port).
  async function setupCaptureProxy(
    handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
    opts: { routeName?: string; prompts?: boolean; upstreamUrl?: string; sink?: LlmCaptureSink } = {},
  ) {
    const upstream = createServer(handler);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upAddr = upstream.address();
    const upPort = typeof upAddr === "object" && upAddr ? upAddr.port : 0;
    const proxyPort = await reservePort();
    const dc = defaultConfig();
    dc.proxy.listen = { host: "127.0.0.1", port: proxyPort };
    dc.proxy.routes.push({
      name: "route",
      match: { host: "", path: "" },
      upstream: { url: opts.upstreamUrl ?? `http://127.0.0.1:${upPort}` },
      auth: NONE_AUTH,
    });
    const source = emptyLlmSource();
    source.name = "cap";
    source.type = "proxy";
    source.via.route = opts.routeName ?? "route";
    source.capture.prompts = opts.prompts ?? true;
    dc.llm.enabled = true;
    dc.llm.sources = [source];
    const store = new LlmCallManager();
    const sink = opts.sink ?? new ProxyCaptureSink({ cfg: () => dc, store });
    const server = new ProxyServer(dc.proxy, undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, sink);
    await server.start();
    return {
      proxyPort,
      store,
      close: async (): Promise<void> => {
        await server.stop();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      },
    };
  }

  const chatBody = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
  const chatResponse = JSON.stringify({
    id: "chatcmpl-x",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });

  test("captures a non-streamed completion and forwards request+response intact", async () => {
    let receivedBody = "";
    const { proxyPort, store, close } = await setupCaptureProxy((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");
        res.end(chatResponse);
      });
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody,
      });
      const text = await resp.text();
      const requestId = resp.headers.get(REQUEST_ID_HEADER) ?? "";
      expect(receivedBody).toBe(chatBody); // request forwarded byte-for-byte
      expect(text).toBe(chatResponse); // response forwarded byte-for-byte
      await waitUntil(() => store.get(requestId) !== undefined);
      const call = store.get(requestId);
      expect(call?.model).toBe("gpt-4o");
      expect(call?.usage?.totalTokens).toBe(6);
      expect(call?.sourceType).toBe("proxy");
      expect((call?.response as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("hello there");
    } finally {
      await close();
    }
  });

  test("records X-Devctl-Service as caller and does not forward it upstream", async () => {
    let seenCallerHeader: string | undefined;
    const { proxyPort, store, close } = await setupCaptureProxy((req, res) => {
      seenCallerHeader = req.headers["x-devctl-service"] as string | undefined;
      res.setHeader("content-type", "application/json");
      res.end(chatResponse);
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-devctl-service": "worker" },
        body: chatBody,
      });
      const requestId = resp.headers.get(REQUEST_ID_HEADER) ?? "";
      await waitUntil(() => store.get(requestId) !== undefined);
      expect(seenCallerHeader).toBeUndefined();
      expect(store.get(requestId)?.caller).toBe("worker");
    } finally {
      await close();
    }
  });

  test("leaves an untagged route byte-identical and captures nothing", async () => {
    let receivedBody = "";
    const { proxyPort, store, close } = await setupCaptureProxy((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.end(chatResponse);
      });
    }, { routeName: "some-other-route" }); // source tags a different route
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody,
      });
      const text = await resp.text();
      expect(receivedBody).toBe(chatBody);
      expect(text).toBe(chatResponse);
      // Give any (erroneous) capture a chance to land, then assert none did.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(store.facets({}).total).toBe(0);
    } finally {
      await close();
    }
  });

  test("reassembles a streamed SSE completion and delivers it intact", async () => {
    const frames = [
      'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ];
    const { proxyPort, store, close } = await setupCaptureProxy((req, res) => {
      req.resume();
      res.setHeader("content-type", "text/event-stream");
      for (const frame of frames) res.write(frame);
      res.end();
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody,
      });
      const text = await resp.text();
      const requestId = resp.headers.get(REQUEST_ID_HEADER) ?? "";
      expect(text).toBe(frames.join("")); // client got the full stream unchanged
      await waitUntil(() => store.get(requestId) !== undefined);
      const call = store.get(requestId);
      expect((call?.response as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("Hello");
      expect(call?.usage?.totalTokens).toBe(3);
      expect(call?.attributes.stream).toBe(true);
    } finally {
      await close();
    }
  });

  test("records a failed row when the upstream is unreachable", async () => {
    const deadPort = await reservePort();
    const { proxyPort, store, close } = await setupCaptureProxy(() => undefined, { upstreamUrl: `http://127.0.0.1:${deadPort}` });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody,
      });
      expect(resp.status).toBe(502);
      await resp.text();
      const requestId = resp.headers.get(REQUEST_ID_HEADER) ?? "";
      await waitUntil(() => store.get(requestId) !== undefined);
      const call = store.get(requestId);
      expect(call?.status).toBe("error");
      expect(call?.model).toBe("gpt-4o"); // still derived from the captured request
    } finally {
      await close();
    }
  });

  test("a throwing sink never disturbs the proxied response", async () => {
    const throwingSink: LlmCaptureSink = {
      begin(_input: LlmCaptureBegin): LlmCaptureRecorder {
        return {
          maxBytes: 1024,
          setRequestBody: () => { throw new Error("boom"); },
          setResponseContentType: () => { throw new Error("boom"); },
          appendResponse: () => { throw new Error("boom"); },
          finish: () => { throw new Error("boom"); },
        };
      },
    };
    const { proxyPort, close } = await setupCaptureProxy((req, res) => {
      req.resume();
      res.end(chatResponse);
    }, { sink: throwingSink });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody,
      });
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe(chatResponse);
    } finally {
      await close();
    }
  });

  test("streams a request with no content-length and marks the stored body omitted", async () => {
    let receivedBody = "";
    const { proxyPort, store, close } = await setupCaptureProxy((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");
        res.end(chatResponse);
      });
    });
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chatBody));
          controller.close();
        },
      });
      // A streamed body has no content-length, so the proxy streams it through
      // instead of buffering and marks the stored request omitted.
      const init = { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as unknown as RequestInit;
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, init);
      const text = await resp.text();
      const requestId = resp.headers.get(REQUEST_ID_HEADER) ?? "";
      expect(receivedBody).toBe(chatBody); // full body still forwarded to upstream
      expect(text).toBe(chatResponse);
      await waitUntil(() => store.get(requestId) !== undefined);
      const call = store.get(requestId);
      expect(call?.request).toBeUndefined();
      expect(call?.attributes.request_omitted).toBe(true);
      expect((call?.response as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("hello there");
    } finally {
      await close();
    }
  });

  test("captures a partial row when the client disconnects mid-stream", async () => {
    const { proxyPort, store, close } = await setupCaptureProxy((req, res) => {
      req.resume();
      res.setHeader("content-type", "text/event-stream");
      // Write one frame and hold the stream open so the client can abort mid-response.
      res.write('data: {"id":"chatcmpl-d","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
    });
    try {
      const requestId = await new Promise<string>((resolve) => {
        const clientReq = httpRequest(
          {
            host: "127.0.0.1",
            port: proxyPort,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(chatBody) },
          },
          (res) => {
            const id = (res.headers[REQUEST_ID_HEADER] as string | undefined) ?? "";
            res.once("data", () => {
              clientReq.destroy(); // abort after the first streamed chunk
              resolve(id);
            });
          },
        );
        clientReq.on("error", () => undefined); // destroy() surfaces as an error; ignore
        clientReq.end(chatBody);
      });
      await waitUntil(() => store.get(requestId) !== undefined);
      const call = store.get(requestId);
      expect(call).toBeDefined();
      const response = call?.response as { choices?: Array<{ message: { content: string } }> } | undefined;
      expect(response?.choices?.[0]?.message.content).toBe("partial");
    } finally {
      await close();
    }
  });

  test("does not store a compressed request body (marks it omitted, still forwards it)", async () => {
    let receivedBody = Buffer.alloc(0);
    const { proxyPort, store, close } = await setupCaptureProxy((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks);
        res.setHeader("content-type", "application/json");
        res.end(chatResponse);
      });
    });
    try {
      const gz = gzipSync(Buffer.from(chatBody));
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: gz,
      });
      await resp.text();
      const requestId = resp.headers.get(REQUEST_ID_HEADER) ?? "";
      expect(receivedBody.equals(gz)).toBe(true); // compressed bytes forwarded verbatim
      await waitUntil(() => store.get(requestId) !== undefined);
      const call = store.get(requestId);
      expect(call?.request).toBeUndefined();
      expect(call?.attributes.request_omitted).toBe(true);
      expect((call?.response as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("hello there");
    } finally {
      await close();
    }
  });
});

describe("proxy traffic inspect", () => {
  async function setupInspectProxy(
    handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
    opts: { inspect?: boolean; maxBytes?: number } = {},
  ) {
    const upstream = createServer(handler);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upAddr = upstream.address();
    const upPort = typeof upAddr === "object" && upAddr ? upAddr.port : 0;
    const proxyPort = await reservePort();
    const dc = defaultConfig();
    dc.proxy.enabled = true;
    dc.proxy.listen = { host: "127.0.0.1", port: proxyPort };
    dc.proxy.routes.push({
      name: "route",
      match: { host: "", path: "" },
      upstream: { url: `http://127.0.0.1:${upPort}` },
      auth: NONE_AUTH,
      inspect: { enabled: opts.inspect ?? true, max_bytes: opts.maxBytes ?? 0 },
    });
    const store = new TrafficCallRing();
    const sink = new ProxyTrafficSink({ cfg: () => dc, store });
    const server = new ProxyServer(dc.proxy, undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, sink);
    await server.start();
    return {
      proxyPort,
      store,
      close: async (): Promise<void> => {
        await server.stop();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      },
    };
  }

  test("captures request and response bodies when inspect.enabled is true", async () => {
    let receivedBody = "";
    const { proxyPort, store, close } = await setupInspectProxy((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/invoices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"id":1}',
      });
      expect(await resp.text()).toBe('{"ok":true}');
      expect(receivedBody).toBe('{"id":1}');
      const requestId = resp.headers.get(REQUEST_ID_HEADER) ?? "";
      await waitUntil(() => store.get(requestId) !== undefined);
      const call = store.get(requestId);
      expect(call?.id).toBe(requestId);
      expect(call?.request?.text).toContain('"id"');
      expect(call?.response?.text).toContain('"ok"');
    } finally {
      await close();
    }
  });

  test("strip_prefix forwards the rewritten path while inspect keeps the inbound path", async () => {
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upAddr = upstream.address();
    const upPort = typeof upAddr === "object" && upAddr ? upAddr.port : 0;
    const proxyPort = await reservePort();
    const dc = defaultConfig();
    dc.proxy.enabled = true;
    dc.proxy.listen = { host: "127.0.0.1", port: proxyPort };
    dc.proxy.routes.push({
      name: "svc",
      match: { host: "", path: "/my-service" },
      upstream: { url: `http://127.0.0.1:${upPort}` },
      auth: NONE_AUTH,
      strip_prefix: true,
      inspect: { enabled: true, max_bytes: 0 },
    });
    const store = new TrafficCallRing();
    const sink = new ProxyTrafficSink({ cfg: () => dc, store });
    const server = new ProxyServer(dc.proxy, undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, sink);
    await server.start();
    try {
      const matrix: Array<[string, string]> = [
        ["/my-service", "/"],
        ["/my-service/foo", "/foo"],
        ["/my-service/foo?q=1", "/foo?q=1"],
      ];
      for (const [inbound, forwarded] of matrix) {
        seen.length = 0;
        const resp = await fetch(`http://127.0.0.1:${proxyPort}${inbound}`);
        expect(await resp.text()).toBe("ok");
        expect(seen).toEqual([forwarded]);
        expect(server.stats().recent[0]?.path).toBe(inbound);
        const requestId = resp.headers.get(REQUEST_ID_HEADER) ?? "";
        await waitUntil(() => store.get(requestId) !== undefined);
        expect(store.get(requestId)?.path).toBe(inbound);
      }
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("does not capture bodies when inspect is off, and still forwards the hop", async () => {
    const { proxyPort, store, close } = await setupInspectProxy((req, res) => {
      req.resume();
      res.end("pong");
    }, { inspect: false });
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/invoices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"id":1}',
      });
      expect(await resp.text()).toBe("pong");
      expect(store.queryPage({}).calls).toEqual([]);
    } finally {
      await close();
    }
  });
});
