import { createServer } from "node:http";
import * as http2 from "node:http2";
import type { ServerHttp2Stream } from "node:http2";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyRouteAuth, type DevctlConfig, type RouteConfig } from "../../domain/config/types.ts";
import type { Bus } from "../../shared/events.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { SpanStore } from "../../ports/span-store.ts";
import type { HttpRecipeRuntime } from "../../ports/http-recipe-runtime.ts";
import type { TokenManager } from "../google/token.ts";
import type { Detector } from "../secrets/detector.ts";
import { ProxyCoordinator, type ProxyCoordinatorDeps } from "./proxy-coordinator.ts";

function memoryLogs(): { logs: LogStore; events: Array<{ source: string; level: string; message: string }> } {
  const events: Array<{ source: string; level: string; message: string }> = [];
  return {
    events,
    logs: {
      append: (event) => {
        events.push({ source: event.source, level: event.level ?? "", message: event.message ?? "" });
      },
    } as LogStore,
  };
}

function recipes(): HttpRecipeRuntime {
  return {
    ensure: async () => ({ status: 200, body: "", contentType: "", values: {} }),
    snapshot: () => undefined,
    start() {},
    stop() {},
    reset() {},
  };
}

function spans(): SpanStore {
  return {
    append: (span) => span as never,
    getTrace: () => ({ traceId: "", spans: [], roots: [] }),
    envelopeMs: () => undefined,
    findTraceIdByRequestId: () => undefined,
    recent: () => [],
    close() {},
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startHttpUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function startGrpcUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http2.createServer();
  server.on("stream", (raw, headers) => {
    const stream = raw as ServerHttp2Stream;
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0", "x-path": String(headers[":path"] ?? "") }));
    stream.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function httpRoute(name: string, path: string, upstream: string): RouteConfig {
  return {
    name,
    match: { host: "", path },
    upstream: { url: upstream },
    auth: emptyRouteAuth(),
  };
}

function grpcRoute(name: string, port: number, upstream: string): RouteConfig {
  return {
    name,
    transport: "grpc",
    listen: { host: "127.0.0.1", port },
    match: { host: "", path: "" },
    upstream: { url: upstream },
    auth: emptyRouteAuth(),
  };
}

function coordinator(cfg: () => DevctlConfig, logs: LogStore): ProxyCoordinator {
  const deps: ProxyCoordinatorDeps = {
    cfg,
    ports: () => new Map(),
    tokens: {} as TokenManager,
    recipes: recipes(),
    logs,
    spans: spans(),
    bus: { publish() {}, subscribe() { return () => undefined; } } as unknown as Bus,
    detector: { redactText: (text: string) => text } as Detector,
    internalTok: () => "internal-token",
    middleware: () => [],
    persistState() {},
  };
  return new ProxyCoordinator(deps);
}

async function grpcCall(port: number, path: string): Promise<{ status: number; grpcStatus?: string }> {
  const client = http2.connect(`http://127.0.0.1:${port}`);
  try {
    return await new Promise((resolve, reject) => {
      // Windows surfaces a closed listen port as a session `error` (ECONNREFUSED)
      // rather than a request rejection, so attach it here or the test fails
      // as an unhandled exception instead of `expect(...).rejects`.
      client.once("error", reject);
      const req = client.request({ ":method": "POST", ":path": path, "content-type": "application/grpc" });
      let status = 0;
      let grpcStatus: string | undefined;
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
        if (headers["grpc-status"] !== undefined) {
          grpcStatus = String(headers["grpc-status"]);
        }
      });
      req.on("trailers", (trailers) => {
        if (trailers["grpc-status"] !== undefined) {
          grpcStatus = String(trailers["grpc-status"]);
        }
      });
      req.on("error", reject);
      req.on("close", () => resolve({ status, grpcStatus }));
      req.end();
    });
  } finally {
    client.close();
  }
}

describe("ProxyCoordinator.applyConfig", () => {
  test("a route-only reload keeps the HTTP listen socket and logs routes reloaded", async () => {
    const up = await startHttpUpstream();
    const port = await reservePort();
    const cfg = defaultConfig();
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port };
    cfg.proxy.routes = [httpRoute("api", "/v1", up.url)];
    const { logs, events } = memoryLogs();
    const coord = coordinator(() => cfg, logs);
    await coord.start();
    const before = coord.instance;
    try {
      const first = await fetch(`http://127.0.0.1:${port}/v1`);
      expect(first.status).toBe(200);
      cfg.proxy.routes = [httpRoute("api", "/v2", up.url)];
      await coord.applyConfig();
      expect(coord.instance).toBe(before);
      expect(coord.isRunning()).toBe(true);
      const miss = await fetch(`http://127.0.0.1:${port}/v1`);
      expect(miss.status).toBe(404);
      const hit = await fetch(`http://127.0.0.1:${port}/v2`);
      expect(hit.status).toBe(200);
      expect(events.some((event) => event.source === "proxy" && event.level === "INFO" && event.message === "proxy routes reloaded")).toBe(true);
      expect(events.some((event) => event.message === "proxy restarting — config reload")).toBe(false);
    } finally {
      await coord.stop();
      await up.close();
    }
  });

  test("changing proxy.listen.port recreates the HTTP server after the restarting log", async () => {
    const up = await startHttpUpstream();
    const port = await reservePort();
    const nextPort = await reservePort();
    const cfg = defaultConfig();
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port };
    cfg.proxy.routes = [httpRoute("api", "", up.url)];
    const { logs, events } = memoryLogs();
    const coord = coordinator(() => cfg, logs);
    await coord.start();
    const before = coord.instance;
    try {
      cfg.proxy.listen = { host: "127.0.0.1", port: nextPort };
      await coord.applyConfig();
      expect(coord.instance).not.toBe(before);
      expect(coord.isRunning()).toBe(true);
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      const hit = await fetch(`http://127.0.0.1:${nextPort}/`);
      expect(hit.status).toBe(200);
      const restartAt = events.findIndex((event) => event.source === "proxy" && event.message === "proxy restarting — config reload");
      expect(restartAt).toBeGreaterThanOrEqual(0);
      expect(events.some((event) => event.message === "proxy routes reloaded")).toBe(false);
    } finally {
      await coord.stop();
      await up.close();
    }
  });

  test("adding and removing a grpc listen port starts and stops only that listener", async () => {
    const httpUp = await startHttpUpstream();
    const grpcUp = await startGrpcUpstream();
    const httpPort = await reservePort();
    const grpcPort = await reservePort();
    const extraPort = await reservePort();
    const cfg = defaultConfig();
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port: httpPort };
    cfg.proxy.routes = [httpRoute("api", "", httpUp.url), grpcRoute("temporal", grpcPort, grpcUp.url)];
    const { logs, events } = memoryLogs();
    const coord = coordinator(() => cfg, logs);
    await coord.start();
    const httpBefore = coord.instance;
    const grpcBefore = coord.grpcServers[0];
    try {
      expect(coord.grpcServers).toHaveLength(1);
      const first = await grpcCall(grpcPort, "/svc.Method");
      expect(first.grpcStatus).toBe("0");

      cfg.proxy.routes = [
        httpRoute("api", "", httpUp.url),
        grpcRoute("temporal", grpcPort, grpcUp.url),
        grpcRoute("extra", extraPort, grpcUp.url),
      ];
      await coord.applyConfig();
      expect(coord.instance).toBe(httpBefore);
      expect(coord.grpcServers[0]).toBe(grpcBefore);
      expect(coord.grpcServers).toHaveLength(2);
      const added = await grpcCall(extraPort, "/extra.Method");
      expect(added.grpcStatus).toBe("0");

      cfg.proxy.routes = [httpRoute("api", "", httpUp.url), grpcRoute("temporal", grpcPort, grpcUp.url)];
      await coord.applyConfig();
      expect(coord.grpcServers).toHaveLength(1);
      expect(coord.grpcServers[0]).toBe(grpcBefore);
      await expect(grpcCall(extraPort, "/extra.Method")).rejects.toThrow();
      const still = await grpcCall(grpcPort, "/svc.Method");
      expect(still.grpcStatus).toBe("0");
      expect(events.some((event) => event.message === "proxy restarting — config reload")).toBe(false);
    } finally {
      await coord.stop();
      await httpUp.close();
      await grpcUp.close();
    }
  });

  test("changing grpc auth/upstream on the same listen port does not close the h2c socket", async () => {
    const grpcUp = await startGrpcUpstream();
    const otherUp = await startGrpcUpstream();
    const httpPort = await reservePort();
    const grpcPort = await reservePort();
    const cfg = defaultConfig();
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port: httpPort };
    cfg.proxy.routes = [grpcRoute("temporal", grpcPort, grpcUp.url)];
    const { logs, events } = memoryLogs();
    const coord = coordinator(() => cfg, logs);
    await coord.start();
    const grpcBefore = coord.grpcServers[0];
    const client = http2.connect(`http://127.0.0.1:${grpcPort}`);
    try {
      const first = await grpcCall(grpcPort, "/before");
      expect(first.grpcStatus).toBe("0");
      const next = grpcRoute("temporal", grpcPort, otherUp.url);
      next.auth = { ...emptyRouteAuth(), type: "none" };
      cfg.proxy.routes = [next];
      await coord.applyConfig();
      expect(coord.grpcServers[0]).toBe(grpcBefore);
      const req = client.request({ ":method": "POST", ":path": "/after", "content-type": "application/grpc" });
      let grpcStatus: string | undefined;
      req.on("trailers", (trailers) => {
        if (trailers["grpc-status"] !== undefined) {
          grpcStatus = String(trailers["grpc-status"]);
        }
      });
      req.on("response", (headers) => {
        if (headers["grpc-status"] !== undefined) {
          grpcStatus = String(headers["grpc-status"]);
        }
      });
      req.end();
      await new Promise<void>((resolve, reject) => {
        req.on("close", () => resolve());
        req.on("error", reject);
      });
      expect(grpcStatus).toBe("0");
      expect(events.some((event) => event.message === "proxy routes reloaded")).toBe(true);
      expect(events.some((event) => event.message === "proxy restarting — config reload")).toBe(false);
    } finally {
      client.close();
      await coord.stop();
      await grpcUp.close();
      await otherUp.close();
    }
  });

  test("applyConfig does not start a suppressed proxy", async () => {
    const port = await reservePort();
    const cfg = defaultConfig();
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port };
    const { logs } = memoryLogs();
    const coord = coordinator(() => cfg, logs);
    coord.setSuppressed(true);
    await coord.applyConfig();
    expect(coord.isRunning()).toBe(false);
    expect(coord.instance).toBeUndefined();
  });

  test("applyConfig starts a config-disabled proxy when enabled again", async () => {
    const up = await startHttpUpstream();
    const port = await reservePort();
    const cfg = defaultConfig();
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port };
    cfg.proxy.routes = [httpRoute("api", "", up.url)];
    const { logs } = memoryLogs();
    const coord = coordinator(() => cfg, logs);
    await coord.start();
    try {
      cfg.proxy.enabled = false;
      await coord.applyConfig();
      expect(coord.isRunning()).toBe(false);
      cfg.proxy.enabled = true;
      await coord.applyConfig();
      expect(coord.isRunning()).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
    } finally {
      await coord.stop();
      await up.close();
    }
  });

  test("a running proxy stops when proxy.enabled becomes false", async () => {
    const up = await startHttpUpstream();
    const port = await reservePort();
    const cfg = defaultConfig();
    cfg.proxy.enabled = true;
    cfg.proxy.listen = { host: "127.0.0.1", port };
    cfg.proxy.routes = [httpRoute("api", "", up.url)];
    const { logs } = memoryLogs();
    const coord = coordinator(() => cfg, logs);
    await coord.start();
    try {
      cfg.proxy.enabled = false;
      await coord.applyConfig();
      expect(coord.isRunning()).toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      await coord.stop();
      await up.close();
    }
  });
});
