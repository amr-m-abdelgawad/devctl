import * as http2 from "node:http2";
import type { ServerHttp2Stream } from "node:http2";
import { describe, expect, test } from "bun:test";
import { GrpcProxyServer } from "./grpc-proxy.ts";
import { TokenManager, type AccessToken, type TokenProvider } from "../google/token.ts";
import { emptyRouteAuth, type RouteConfig } from "../../domain/config/types.ts";
import { type CredentialRecord, type CredentialStore } from "../storage/credentials.ts";

function memoryStore(): CredentialStore {
  const records = new Map<string, CredentialRecord>();
  return {
    backend: "file",
    get: async (k) => records.get(k),
    set: async (k, r) => void records.set(k, r),
    delete: async (k) => void records.delete(k),
    list: async () => [],
  };
}

function tokens(accessToken = "ID-TOKEN"): TokenManager {
  const tok: AccessToken = { accessToken, tokenType: "Bearer", expiresAt: new Date(Date.now() + 3_600_000), audience: "", identity: "user", scopes: [] };
  const provider: TokenProvider = { name: "stub", fetch: async () => tok };
  return new TokenManager(60_000, [provider], undefined, memoryStore());
}

// Upstream stand-in for Temporal: reflects the Authorization + identity-token it
// received into response trailers, and branches on the gRPC method path.
async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http2.createServer();
  server.on("stream", (raw, headers) => {
    const stream = raw as ServerHttp2Stream;
    const path = String(headers[":path"] ?? "");
    const seenAuth = String(headers["authorization"] ?? "(none)");
    const seenIdToken = String(headers["identity-token"] ?? "(none)");
    if (path === "/deny") {
      stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "7", "grpc-message": "denied" }, { endStream: true });
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0", "x-seen-auth": seenAuth, "x-seen-id-token": seenIdToken }));
      if (path === "/stream") {
        stream.write("chunk-1");
        stream.write("chunk-2");
        stream.end("chunk-3");
      } else {
        stream.end(Buffer.concat(chunks));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function grpcRoute(upstreamUrl: string, port: number, extra: Partial<RouteConfig["auth"]> = {}): RouteConfig {
  return {
    name: "temporal",
    transport: "grpc",
    listen: { host: "127.0.0.1", port },
    match: { host: "", path: "" },
    upstream: { url: upstreamUrl },
    auth: { ...emptyRouteAuth(), type: "service_account", identity: { type: "service_account", service_account: "sa@x.iam.gserviceaccount.com" }, ...extra },
  };
}

async function reservePort(): Promise<number> {
  const s = http2.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// gRPC carries grpc-status in trailers normally, but in the *response headers*
// for a trailers-only response (errors). Capture it from either place.
type CallResult = { body: string; trailers: Record<string, string>; status: number; grpcStatus?: string };

async function call(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<CallResult> {
  const client = http2.connect(`http://127.0.0.1:${port}`);
  try {
    const req = client.request({ ":method": "POST", ":path": path, "content-type": "application/grpc", ...headers });
    let out = "";
    let status = 0;
    let grpcStatus: string | undefined;
    const trailers: Record<string, string> = {};
    req.setEncoding("utf8");
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
      if (h["grpc-status"] !== undefined) grpcStatus = String(h["grpc-status"]);
    });
    req.on("data", (c) => (out += c));
    req.on("trailers", (t) => {
      Object.assign(trailers, t);
      if (t["grpc-status"] !== undefined) grpcStatus = String(t["grpc-status"]);
    });
    req.end(body);
    await new Promise<void>((resolve, reject) => {
      req.on("close", () => resolve());
      req.on("error", reject);
    });
    return { body: out, trailers, status, grpcStatus };
  } finally {
    client.close();
  }
}

describe("GrpcProxyServer", () => {
  test("injects the minted Authorization, ignores the client's, and relays body + trailers", async () => {
    const up = await startUpstream();
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(up.url, port), tokens("ID-TOKEN"));
    await server.start();
    try {
      const res = await call(port, "/say.Hello", "payload", { authorization: "Bearer CLIENT-JUNK" });
      expect(res.body).toBe("payload");
      expect(res.trailers["grpc-status"]).toBe("0");
      expect(res.trailers["x-seen-auth"]).toBe("Bearer ID-TOKEN"); // proxy's token, not the client's
    } finally {
      await server.stop();
      await up.close();
    }
  });

  test("injects configured auth.headers with the token substituted for ${token}", async () => {
    const up = await startUpstream();
    const port = await reservePort();
    const route = grpcRoute(up.url, port, { headers: { "identity-token": "${token}" } });
    const server = new GrpcProxyServer(route, tokens("ID-TOKEN"));
    await server.start();
    try {
      const res = await call(port, "/say.Hello", "x");
      expect(res.trailers["x-seen-id-token"]).toBe("ID-TOKEN");
    } finally {
      await server.stop();
      await up.close();
    }
  });

  test("relays a server-streaming response", async () => {
    const up = await startUpstream();
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(up.url, port), tokens());
    await server.start();
    try {
      const res = await call(port, "/stream", "go");
      expect(res.body).toBe("chunk-1chunk-2chunk-3");
      expect(res.trailers["grpc-status"]).toBe("0");
    } finally {
      await server.stop();
      await up.close();
    }
  });

  test("forwards an upstream trailers-only gRPC error", async () => {
    const up = await startUpstream();
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(up.url, port), tokens());
    await server.start();
    try {
      const res = await call(port, "/deny", "x");
      expect(res.grpcStatus).toBe("7");
    } finally {
      await server.stop();
      await up.close();
    }
  });

  test("returns grpc-status 14 when the upstream is unavailable", async () => {
    const dead = await reservePort(); // nothing listening
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(`http://127.0.0.1:${dead}`, port), tokens());
    await server.start();
    try {
      const res = await call(port, "/say.Hello", "x");
      expect(res.grpcStatus).toBe("14");
    } finally {
      await server.stop();
    }
  });

  test("counts a non-OK grpc-status as an error in stats", async () => {
    const up = await startUpstream();
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(up.url, port), tokens());
    await server.start();
    try {
      await call(port, "/say.Hello", "x"); // grpc-status 0
      await call(port, "/deny", "x"); // grpc-status 7
      const s = server.stats();
      expect(s.total).toBe(2);
      expect(s.errors).toBe(1);
    } finally {
      await server.stop();
      await up.close();
    }
  });

  test("records a cancelled RPC when the client goes away mid-flight", async () => {
    const hang = http2.createServer();
    hang.on("stream", () => {
      /* never responds — hold the stream open */
    });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
    const hangPort = (hang.address() as { port: number }).port;
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(`http://127.0.0.1:${hangPort}`, port), tokens());
    await server.start();
    const client = http2.connect(`http://127.0.0.1:${port}`);
    try {
      const req = client.request({ ":method": "POST", ":path": "/hang", "content-type": "application/grpc" });
      req.on("error", () => {});
      req.end("x");
      await new Promise<void>((r) => setTimeout(r, 60)); // let it reach the upstream
      req.close(http2.constants.NGHTTP2_CANCEL); // client cancels the RPC
      for (let i = 0; i < 100 && server.stats().total === 0; i++) {
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      const s = server.stats();
      expect(s.total).toBeGreaterThanOrEqual(1); // recorded via the front 'close' handler
      expect(s.errors).toBeGreaterThanOrEqual(1); // cancelled counts as an error
    } finally {
      client.close();
      await server.stop();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });
});
