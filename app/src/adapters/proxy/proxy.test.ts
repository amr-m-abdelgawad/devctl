import { createServer } from "node:http";
import { connect } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { defaultConfig, type RouteAuthConfig } from "../../domain/config/types.ts";
import { startMockIapServer } from "../google/testdata/mock-iap-server.ts";
import { type CredentialRecord, type CredentialStore } from "../storage/credentials.ts";
import { KindProxy } from "../../shared/errors.ts";
import { Bus, TokenRefreshFailed, TokenRefreshed } from "../../shared/events.ts";
import { LogManager } from "../storage/logs.ts";
import { INTERNAL_TOKEN_HEADER, matchRoute, ProxyServer, REQUEST_ID_HEADER, resolveProxyTarget, TokenEndpoint } from "./proxy.ts";
import { Detector } from "../secrets/detector.ts";
import { TokenManager, type AccessToken } from "../google/token.ts";

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

const NONE_AUTH: RouteAuthConfig = { type: "none", identity: { type: "user", service_account: "" }, audience: "", service_account: "" };

async function setupProxy(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  opts: { auth?: RouteAuthConfig; tokens?: TokenManager; logs?: LogManager; bus?: Bus } = {},
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
      auth: { type: "iap", identity: { type: "user", service_account: "" }, audience: "/projects/1/iap", service_account: "" },
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
    const ep = new TokenEndpoint("127.0.0.1", 0, "s3cret", tokens);
    await ep.start();
    const port = ep.listenPort();
    const identity = "sa:test-389@company-dev.iam.gserviceaccount.com";
    const audience = "https://invoices-worker.local";
    const query = new URLSearchParams({ identity, audience }).toString();
    const resp = await fetch(`http://127.0.0.1:${port}/token?${query}`, { headers: { [INTERNAL_TOKEN_HEADER]: "s3cret" } });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.identity).toBe(identity);
    expect(calls).toEqual([{ identity, audience }]);
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
    };
    const { proxyPort, close, seen } = await setupHeaderCapture(auth, tokens);
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/invoices`);
    expect(resp.status).toBe(200);
    expect(seen.headers.authorization).toBe("Bearer tok-sa:test-389@example.com-https://invoices-worker.local");
    expect(calls).toEqual([{ identity: "sa:test-389@example.com", audience: "https://invoices-worker.local" }]);
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
