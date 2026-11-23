import * as http2 from "node:http2";
import type { ServerHttp2Stream } from "node:http2";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { UpstreamTiming } from "./grpc-upstream.ts";
import { GrpcProxyServer, writeWithBackpressure } from "./grpc-proxy.ts";
import { TokenManager, type AccessToken, type TokenProvider } from "../google/token.ts";
import { defaultConfig, emptyRouteAuth, type RouteConfig } from "../../domain/config/types.ts";
import type { LogStore } from "../../ports/log-store.ts";
import { TrafficCallRing } from "../traffic/store.ts";
import { ProxyTrafficSink } from "../traffic/capture.ts";
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
async function startUpstream(): Promise<{ url: string; close: () => Promise<void>; connections: () => number }> {
  const server = http2.createServer();
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  server.on("stream", (raw, headers) => {
    const stream = raw as ServerHttp2Stream;
    const path = String(headers[":path"] ?? "");
    const seenAuth = String(headers["authorization"] ?? "(none)");
    const seenIdToken = String(headers["identity-token"] ?? "(none)");
    const seenProxyAuth = String(headers["proxy-authorization"] ?? "(none)");
    if (path === "/deny") {
      stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "7", "grpc-message": "denied" }, { endStream: true });
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0", "x-seen-auth": seenAuth, "x-seen-id-token": seenIdToken, "x-seen-proxy-auth": seenProxyAuth }));
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
  return { url: `http://127.0.0.1:${port}`, connections: () => connections, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function memoryLogs(): { logs: Pick<LogStore, "append">; events: Array<{ level: string; message: string; attributes?: Record<string, unknown> }> } {
  const events: Array<{ level: string; message: string; attributes?: Record<string, unknown> }> = [];
  return {
    events,
    logs: {
      append: (event) => {
        events.push({ level: event.level ?? "", message: event.message ?? "", attributes: event.attributes });
      },
    },
  };
}

async function startStatusUpstream(statusFor: (path: string) => string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http2.createServer();
  server.on("stream", (raw, headers) => {
    const stream = raw as ServerHttp2Stream;
    const path = String(headers[":path"] ?? "");
    const status = statusFor(path);
    stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": status, "grpc-message": status === "0" ? "ok" : "err" }, { endStream: true });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Forwards bytes until drop(). After that the TCP connection stays open and
// data is discarded, so the proxy sees an ESTABLISHED socket with no HTTP/2
// PING acknowledgement. New connections still forward.
function startSilentProxy(targetPort: number): Promise<{ port: number; drop: () => void; close: () => Promise<void> }> {
  const links: Array<{ from: Socket; to: Socket; open: boolean }> = [];
  const proxy = createNetServer((from) => {
    const to = netConnect(targetPort, "127.0.0.1");
    const link = { from, to, open: true };
    links.push(link);
    const tear = (): void => {
      from.destroy();
      to.destroy();
    };
    from.on("error", tear);
    to.on("error", tear);
    from.on("data", (chunk: Buffer) => {
      if (link.open) to.write(chunk);
    });
    to.on("data", (chunk: Buffer) => {
      if (link.open) from.write(chunk);
    });
  });
  return new Promise((resolve) => {
    proxy.listen(0, "127.0.0.1", () => {
      const port = (proxy.address() as { port: number }).port;
      resolve({
        port,
        drop() {
          for (const link of links) link.open = false;
        },
        close: () => new Promise((done) => {
          for (const link of links) {
            link.from.destroy();
            link.to.destroy();
          }
          proxy.close(() => done());
        }),
      });
    });
  });
}

// Each mint looks expired, so every RPC refetches. `dns` simulates oauth2.googleapis.com failing.
function remintingTokens(gate: { dns: boolean }): TokenManager {
  const provider: TokenProvider = {
    name: "stub",
    fetch: async () => {
      if (gate.dns) {
        const err = new Error("getaddrinfo EAI_AGAIN oauth2.googleapis.com") as NodeJS.ErrnoException;
        err.code = "EAI_AGAIN";
        throw err;
      }
      return { accessToken: "ID-TOKEN", tokenType: "Bearer", expiresAt: new Date(Date.now() + 1_000), audience: "", identity: "user", scopes: [] };
    },
  };
  return new TokenManager(60_000, [provider], undefined, memoryStore());
}

// Stands in for the client's h2 stream when it can no longer take response
// headers (reset, or torn down between the upstream answering and the relay).
class ClosedFront extends PassThrough {
  override closed = false;
  headersSent = false;
  closedWith: number | undefined;
  readonly session = undefined;

  constructor() {
    // A real h2 stream stays open after the client finishes sending.
    super({ autoDestroy: false });
  }

  respond(): void {
    throw new Error("The stream has been destroyed");
  }

  sendTrailers(): void {
    throw new Error("The stream has been destroyed");
  }

  close(code?: number): void {
    this.closedWith = code;
    this.closed = true;
    this.destroy();
  }
}

type Serve = { serve(front: unknown, headers: Record<string, string>): Promise<void> };

async function serveThroughClosedFront(server: GrpcProxyServer, path: string): Promise<{ front: ClosedFront; escaped: unknown[] }> {
  const escaped: unknown[] = [];
  const onUncaught = (err: unknown): void => {
    escaped.push(err);
  };
  process.on("uncaughtException", onUncaught);
  const front = new ClosedFront();
  try {
    front.on("error", () => {});
    await (server as unknown as Serve).serve(front, { ":method": "POST", ":path": path, "content-type": "application/grpc" });
    front.end("payload");
    for (let i = 0; i < 100 && server.stats().total === 0; i++) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    await new Promise<void>((r) => setTimeout(r, 20));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  return { front, escaped };
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
  test("writeWithBackpressure pauses the source when dest.write returns false", () => {
    const src = new PassThrough();
    const dest = new PassThrough({ highWaterMark: 8 });
    src.resume();
    dest.pause();
    expect(src.isPaused()).toBe(false);
    writeWithBackpressure(src, dest, Buffer.alloc(32));
    expect(src.isPaused()).toBe(true);
  });

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

  test("replaceRoute updates auth on the same h2c listen socket", async () => {
    const up = await startUpstream();
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(up.url, port), tokens("FIRST"));
    await server.start();
    try {
      const before = await call(port, "/say.Hello", "a");
      expect(before.trailers["x-seen-auth"]).toBe("Bearer FIRST");
      const next = grpcRoute(up.url, port, { headers: { "identity-token": "${token}" } });
      server.replaceRoute(next);
      const after = await call(port, "/say.Hello", "b");
      expect(after.trailers["grpc-status"]).toBe("0");
      expect(after.trailers["x-seen-id-token"]).toBe("FIRST");
      expect(server.isRunning()).toBe(true);
      expect(server.listenKey()).toBe(`127.0.0.1:${port}`);
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

  test("suppress_authorization keeps caller Authorization and injects Proxy-Authorization", async () => {
    const up = await startUpstream();
    const port = await reservePort();
    const route = grpcRoute(up.url, port, {
      suppress_authorization: true,
      headers: { "Proxy-Authorization": "Bearer ${token}" },
    });
    const server = new GrpcProxyServer(route, tokens("ID-TOKEN"));
    await server.start();
    try {
      const res = await call(port, "/say.Hello", "x", { authorization: "Bearer workspace-oauth" });
      expect(res.trailers["grpc-status"]).toBe("0");
      expect(res.trailers["x-seen-auth"]).toBe("Bearer workspace-oauth");
      expect(res.trailers["x-seen-proxy-auth"]).toBe("Bearer ID-TOKEN");
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

  test("log.grpc.ok treats listed Poll* status 14 as INFO without incrementing errors", async () => {
    const up = await startStatusUpstream((path) => (path.endsWith("PollWorkflowTaskQueue") || path.endsWith("PollActivityTaskQueue") ? "14" : "7"));
    const port = await reservePort();
    const route = grpcRoute(up.url, port);
    route.log = { grpc: { ok: [{ status: 14, methods: ["PollWorkflowTaskQueue", "PollActivityTaskQueue"] }] } };
    const { logs, events } = memoryLogs();
    const server = new GrpcProxyServer(route, tokens(), logs);
    await server.start();
    try {
      const poll = "/temporal.api.workflowservice.v1.WorkflowService/PollWorkflowTaskQueue";
      await call(port, poll, "x");
      await call(port, "/temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue", "x");
      await call(port, "/temporal.api.workflowservice.v1.WorkflowService/TerminateWorkflowExecution", "x");
      const s = server.stats();
      expect(s.total).toBe(3);
      expect(s.errors).toBe(1);
      const hop = (method: string) => events.filter((e) => e.message.includes(method));
      expect(hop("PollWorkflowTaskQueue").some((e) => e.level === "INFO" && e.message.includes("grpc-status=14") && e.attributes?.["rpc.system"] === "grpc")).toBe(true);
      expect(hop("PollActivityTaskQueue").some((e) => e.level === "INFO" && e.message.includes("grpc-status=14"))).toBe(true);
      expect(hop("TerminateWorkflowExecution").some((e) => e.level === "WARN" && e.message.includes("grpc-status 7"))).toBe(true);
    } finally {
      await server.stop();
      await up.close();
    }
  });

  test("log.grpc.ok inspect false skips the traffic ring for status 0 and still stores other methods", async () => {
    const up = await startStatusUpstream(() => "0");
    const port = await reservePort();
    const route = grpcRoute(up.url, port);
    route.auth = { ...emptyRouteAuth(), type: "none", identity: { type: "user", service_account: "" } };
    route.inspect = { enabled: true, max_bytes: 0 };
    route.log = {
      grpc: {
        ok: [{ status: 0, methods: ["PollWorkflowTaskQueue"], log: "silent", inspect: false }],
      },
    };
    const cfg = defaultConfig();
    cfg.proxy.enabled = true;
    cfg.proxy.routes = [route];
    const store = new TrafficCallRing();
    const sink = new ProxyTrafficSink({ cfg: () => cfg, store });
    const { logs, events } = memoryLogs();
    const server = new GrpcProxyServer(route, tokens(), logs, undefined, undefined, undefined, sink);
    await server.start();
    try {
      const poll = "/temporal.api.workflowservice.v1.WorkflowService/PollWorkflowTaskQueue";
      await call(port, poll, "x");
      await call(port, "/temporal.api.workflowservice.v1.WorkflowService/StartWorkflowExecution", "x");
      expect(server.stats().total).toBe(2);
      expect(server.stats().errors).toBe(0);
      expect(events.filter((event) => event.message.includes("PollWorkflowTaskQueue"))).toEqual([]);
      expect(events.some((event) => event.level === "INFO" && event.message.includes("StartWorkflowExecution"))).toBe(true);
      const deadline = Date.now() + 1000;
      while (store.queryPage({}).calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const captured = store.queryPage({}).calls;
      expect(captured.map((call) => call.path)).toEqual(["/temporal.api.workflowservice.v1.WorkflowService/StartWorkflowExecution"]);
    } finally {
      await server.stop();
      await up.close();
    }
  });

  test("log.grpc.ok silent omits the hop log; omit methods applies to every method", async () => {
    const up = await startStatusUpstream(() => "14");
    const port = await reservePort();
    const route = grpcRoute(up.url, port);
    route.log = { grpc: { ok: [{ status: 14, log: "silent" }] } };
    const { logs, events } = memoryLogs();
    const server = new GrpcProxyServer(route, tokens(), logs);
    await server.start();
    try {
      await call(port, "/temporal.api.workflowservice.v1.WorkflowService/Whatever", "x");
      expect(server.stats().errors).toBe(0);
      expect(events.filter((e) => e.message.includes("/Whatever"))).toEqual([]);
    } finally {
      await server.stop();
      await up.close();
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

  test("total_ms aborts a hanging stream with grpc-status 4", async () => {
    const hang = http2.createServer();
    hang.on("stream", () => {
      /* never responds */
    });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
    const hangPort = (hang.address() as { port: number }).port;
    const port = await reservePort();
    const route = grpcRoute(`http://127.0.0.1:${hangPort}`, port);
    route.timeout = { total_ms: 50 };
    const server = new GrpcProxyServer(route, tokens());
    await server.start();
    try {
      const res = await call(port, "/hang", "x");
      expect(res.grpcStatus).toBe("4");
      expect(res.status).toBe(200);
      expect(server.stats().errors).toBeGreaterThanOrEqual(1);
      expect(server.stats().recent[0]?.error).toBe("proxy total timeout");
    } finally {
      await server.stop();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  test("idle_ms aborts when DATA frames stall", async () => {
    const hang = http2.createServer();
    hang.on("stream", (raw) => {
      const stream = raw as ServerHttp2Stream;
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.write("ping");
    });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
    const hangPort = (hang.address() as { port: number }).port;
    const port = await reservePort();
    const route = grpcRoute(`http://127.0.0.1:${hangPort}`, port);
    route.timeout = { idle_ms: 50 };
    const server = new GrpcProxyServer(route, tokens());
    await server.start();
    try {
      const res = await call(port, "/stall", "x");
      expect(res.body.includes("ping")).toBe(true);
      expect(res.grpcStatus).toBe("4");
      expect(server.stats().recent.some((row) => row.error === "proxy idle timeout")).toBe(true);
    } finally {
      await server.stop();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  test("missing timeout still allows a long stream", async () => {
    const delayed = http2.createServer();
    delayed.on("stream", (raw) => {
      const stream = raw as ServerHttp2Stream;
      setTimeout(() => {
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "0" }, { endStream: true });
      }, 200);
    });
    await new Promise<void>((r) => delayed.listen(0, "127.0.0.1", () => r()));
    const delayedPort = (delayed.address() as { port: number }).port;
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(`http://127.0.0.1:${delayedPort}`, port), tokens());
    await server.start();
    try {
      const res = await call(port, "/slow-ok", "x");
      expect(res.grpcStatus).toBe("0");
      expect(server.stats().errors).toBe(0);
    } finally {
      await server.stop();
      await new Promise<void>((r) => delayed.close(() => r()));
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

  test("a response the client stream can no longer take is recorded, not thrown out of the handler", async () => {
    const up = await startUpstream();
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(up.url, port), tokens());
    try {
      const streamed = await serveThroughClosedFront(server, "/say.Hello");
      expect(streamed.escaped).toEqual([]);
      expect(streamed.front.closedWith).toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);
      const trailersOnly = await serveThroughClosedFront(server, "/deny");
      expect(trailersOnly.escaped).toEqual([]);
      const stats = server.stats();
      expect(stats.total).toBe(2);
      expect(stats.errors).toBe(2);
      expect(stats.recent.map((row) => row.status)).toEqual([502, 502]);
      expect(stats.recent.every((row) => (row.error ?? "").includes("The stream has been destroyed"))).toBe(true);
    } finally {
      await server.stop();
      await up.close();
    }
  });

  test("tees DATA frames into the traffic store up to max_bytes", async () => {
    const up = await startUpstream();
    const port = await reservePort();
    const route = grpcRoute(up.url, port);
    route.auth = { ...emptyRouteAuth(), type: "none", identity: { type: "user", service_account: "" } };
    route.inspect = { enabled: true, max_bytes: 8 };
    const cfg = defaultConfig();
    cfg.proxy.enabled = true;
    cfg.proxy.routes = [route];
    const store = new TrafficCallRing();
    const sink = new ProxyTrafficSink({ cfg: () => cfg, store });
    const server = new GrpcProxyServer(route, tokens(), undefined, undefined, undefined, undefined, sink);
    await server.start();
    try {
      const res = await call(port, "/say.Hello", "payload-too-long");
      expect(res.body).toBe("payload-too-long");
      expect(res.trailers["grpc-status"]).toBe("0");
      const deadline = Date.now() + 1000;
      while (store.queryPage({}).calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const captured = store.queryPage({}).calls[0];
      expect(captured?.transport).toBe("grpc");
      expect(captured?.request?.truncated).toBe(true);
      expect(captured?.request?.encoding).toBe("base64");
      expect(Buffer.from(captured?.request?.data ?? "", "base64").length).toBe(8);
    } finally {
      await server.stop();
      await up.close();
    }
  });

  test("a later RPC opens a new upstream connection after the pooled one goes silent", async () => {
    const up = await startUpstream();
    const targetPort = Number(new URL(up.url).port);
    const hole = await startSilentProxy(targetPort);
    const port = await reservePort();
    let now = Date.now();
    const timing: UpstreamTiming = { pingIntervalMs: 30_000, pingTimeoutMs: 300, connectTimeoutMs: 1_000, now: () => now };
    const server = new GrpcProxyServer(grpcRoute(`http://127.0.0.1:${hole.port}`, port), tokens(), undefined, undefined, undefined, undefined, undefined, timing);
    await server.start();
    try {
      const first = await call(port, "/say.Hello", "a");
      expect(first.grpcStatus).toBe("0");
      expect(up.connections()).toBe(1);
      hole.drop();
      now += 30_000;
      const started = Date.now();
      const second = await call(port, "/say.Hello", "b");
      expect(second.grpcStatus).toBe("0");
      expect(second.body).toBe("b");
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(up.connections()).toBeGreaterThanOrEqual(2);
    } finally {
      await server.stop();
      await hole.close();
      await up.close();
    }
  });

  test("an in-flight RPC fails with UNAVAILABLE when the upstream stops answering", async () => {
    let sawStream: () => void = () => {};
    const seen = new Promise<void>((resolve) => {
      sawStream = resolve;
    });
    const hang = http2.createServer();
    hang.on("session", (session) => {
      session.on("error", () => {});
    });
    hang.on("stream", (stream) => {
      stream.on("error", () => {});
      sawStream();
    });
    hang.on("connection", (socket) => socket.on("error", () => {}));
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", () => resolve()));
    const hangPort = (hang.address() as { port: number }).port;
    const hole = await startSilentProxy(hangPort);
    const port = await reservePort();
    const timing: UpstreamTiming = { pingIntervalMs: 100, pingTimeoutMs: 300, connectTimeoutMs: 1_000 };
    const { logs, events } = memoryLogs();
    const server = new GrpcProxyServer(grpcRoute(`http://127.0.0.1:${hole.port}`, port), tokens(), logs, undefined, undefined, undefined, undefined, timing);
    await server.start();
    try {
      const pending = call(port, "/hang", "x");
      await seen;
      hole.drop();
      const started = Date.now();
      const res = await pending;
      expect(res.grpcStatus).toBe("14");
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(server.stats().recent.some((row) => (row.error ?? "").includes("client closed"))).toBe(false);
      expect(events.some((event) => event.level === "WARN" && event.message.includes("dropped"))).toBe(true);
    } finally {
      await server.stop();
      await hole.close();
      await new Promise<void>((resolve) => hang.close(() => resolve()));
    }
  });

  test("a token-mint network error makes the next RPC replace a silent upstream", async () => {
    const up = await startUpstream();
    const hole = await startSilentProxy(Number(new URL(up.url).port));
    const port = await reservePort();
    const gate = { dns: false };
    const timing: UpstreamTiming = { pingIntervalMs: 60_000, pingTimeoutMs: 300, connectTimeoutMs: 1_000 };
    const server = new GrpcProxyServer(grpcRoute(`http://127.0.0.1:${hole.port}`, port), remintingTokens(gate), undefined, undefined, undefined, undefined, undefined, timing);
    await server.start();
    try {
      expect((await call(port, "/say.Hello", "a")).grpcStatus).toBe("0");
      expect(up.connections()).toBe(1);
      hole.drop();
      gate.dns = true;
      const denied = await call(port, "/say.Hello", "b");
      expect(denied.grpcStatus).toBe("16");
      gate.dns = false;
      const started = Date.now();
      const recovered = await call(port, "/say.Hello", "c");
      expect(recovered.grpcStatus).toBe("0");
      expect(recovered.body).toBe("c");
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(up.connections()).toBeGreaterThanOrEqual(2);
    } finally {
      await server.stop();
      await hole.close();
      await up.close();
    }
  });

  test("a handshake that never finishes returns UNAVAILABLE", async () => {
    const sink = createNetServer((socket) => {
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", () => resolve()));
    const sinkPort = (sink.address() as { port: number }).port;
    const port = await reservePort();
    const timing: UpstreamTiming = { connectTimeoutMs: 300, pingIntervalMs: 60_000, pingTimeoutMs: 300 };
    const server = new GrpcProxyServer(grpcRoute(`http://127.0.0.1:${sinkPort}`, port), tokens(), undefined, undefined, undefined, undefined, undefined, timing);
    await server.start();
    try {
      const started = Date.now();
      const res = await call(port, "/say.Hello", "x");
      expect(res.grpcStatus).toBe("14");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(server.stats().recent[0]?.error).toContain("upstream connect timeout");
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });

  test("a silent long-poll stays open while HTTP/2 PINGs are answered", async () => {
    const delayed = http2.createServer();
    delayed.on("stream", (raw) => {
      const stream = raw as ServerHttp2Stream;
      setTimeout(() => {
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "0" }, { endStream: true });
      }, 500);
    });
    await new Promise<void>((resolve) => delayed.listen(0, "127.0.0.1", () => resolve()));
    const delayedPort = (delayed.address() as { port: number }).port;
    const port = await reservePort();
    const timing: UpstreamTiming = { pingIntervalMs: 100, pingTimeoutMs: 400, connectTimeoutMs: 1_000 };
    const server = new GrpcProxyServer(grpcRoute(`http://127.0.0.1:${delayedPort}`, port), tokens(), undefined, undefined, undefined, undefined, undefined, timing);
    await server.start();
    try {
      const res = await call(port, "/slow-ok", "x");
      expect(res.grpcStatus).toBe("0");
      expect(server.stats().errors).toBe(0);
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => delayed.close(() => resolve()));
    }
  });

  test("a client cancel leaves the upstream connection for the next RPC", async () => {
    const up = http2.createServer();
    let connections = 0;
    up.on("connection", () => {
      connections += 1;
    });
    up.on("stream", (raw, headers) => {
      const stream = raw as ServerHttp2Stream;
      if (String(headers[":path"] ?? "") === "/hang") return;
      stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "0" }, { endStream: true });
    });
    await new Promise<void>((resolve) => up.listen(0, "127.0.0.1", () => resolve()));
    const upPort = (up.address() as { port: number }).port;
    const port = await reservePort();
    const server = new GrpcProxyServer(grpcRoute(`http://127.0.0.1:${upPort}`, port), tokens());
    await server.start();
    const client = http2.connect(`http://127.0.0.1:${port}`);
    try {
      const req = client.request({ ":method": "POST", ":path": "/hang", "content-type": "application/grpc" });
      req.on("error", () => {});
      req.end("x");
      await delay(60);
      req.close(http2.constants.NGHTTP2_CANCEL);
      for (let i = 0; i < 50 && server.stats().total === 0; i += 1) await delay(20);
      const res = await call(port, "/ok", "x");
      expect(res.grpcStatus).toBe("0");
      expect(connections).toBe(1);
    } finally {
      client.close();
      await server.stop();
      await new Promise<void>((resolve) => up.close(() => resolve()));
    }
  });
});
