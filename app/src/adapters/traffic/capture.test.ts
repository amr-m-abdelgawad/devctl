import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyRouteAuth, emptyRouteInspect, type DevctlConfig, type RouteConfig } from "../../domain/config/types.ts";
import { TrafficCallRing } from "./store.ts";
import { ProxyTrafficSink } from "./capture.ts";

function inspectRoute(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    name: "invoices-api",
    match: { host: "", path: "" },
    upstream: { url: "http://127.0.0.1:9" },
    auth: emptyRouteAuth(),
    inspect: { enabled: true, max_bytes: 32 },
    ...overrides,
  };
}

function cfgWithInspect(mutate: (cfg: DevctlConfig) => void = () => undefined): DevctlConfig {
  const cfg = defaultConfig();
  cfg.proxy.enabled = true;
  cfg.proxy.routes = [inspectRoute()];
  mutate(cfg);
  return cfg;
}

const begin = {
  routeName: "invoices-api",
  method: "POST",
  path: "/invoices",
  requestHeaders: { "content-type": "application/json", "x-devctl-service": "worker" },
  transport: "http" as const,
};

describe("ProxyTrafficSink.begin", () => {
  test("captures when inspect.enabled is on a live proxy route", () => {
    const sink = new ProxyTrafficSink({ cfg: () => cfgWithInspect(), store: new TrafficCallRing() });
    const rec = sink.begin(begin);
    expect(rec).toBeDefined();
    expect(rec?.maxBytes).toBe(32);
  });

  test("ignores inspect when the proxy is off, the route is a recipe, or inspect is disabled", () => {
    const off = cfgWithInspect((cfg) => {
      cfg.proxy.enabled = false;
    });
    expect(new ProxyTrafficSink({ cfg: () => off, store: new TrafficCallRing() }).begin(begin)).toBeUndefined();

    const recipe = cfgWithInspect((cfg) => {
      cfg.proxy.routes[0] = inspectRoute({ upstream: { url: "http://127.0.0.1:9", recipe: "cached" } });
    });
    expect(new ProxyTrafficSink({ cfg: () => recipe, store: new TrafficCallRing() }).begin(begin)).toBeUndefined();

    const disabled = cfgWithInspect((cfg) => {
      cfg.proxy.routes[0] = inspectRoute({ inspect: emptyRouteInspect() });
    });
    expect(new ProxyTrafficSink({ cfg: () => disabled, store: new TrafficCallRing() }).begin(begin)).toBeUndefined();

    expect(new ProxyTrafficSink({ cfg: () => cfgWithInspect(), store: new TrafficCallRing() }).begin({
      ...begin,
      routeName: "other",
    })).toBeUndefined();
  });
});

describe("ProxyTrafficSink recorder", () => {
  test("stores HTTP JSON bodies and the caller header", async () => {
    const store = new TrafficCallRing();
    const sink = new ProxyTrafficSink({ cfg: () => cfgWithInspect(), store });
    const rec = sink.begin(begin);
    if (!rec) {
      throw new Error("expected a recorder");
    }
    rec.setRequestBody(Buffer.from('{"id":1}'));
    rec.setResponseContentType("application/json");
    rec.appendResponse(Buffer.from('{"ok":true}'));
    await rec.finish({
      status: 201,
      durationMs: 12,
      requestId: "req-1",
      traceId: "trace-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const call = store.get("req-1");
    expect(call?.caller).toBe("worker");
    expect(call?.status).toBe(201);
    expect(call?.traceId).toBe("trace-1");
    expect(call?.request?.text).toContain('"id"');
    expect(call?.response?.text).toContain('"ok"');
  });

  test("truncates gRPC DATA past max_bytes while still finishing", async () => {
    const store = new TrafficCallRing();
    const sink = new ProxyTrafficSink({ cfg: () => cfgWithInspect(), store });
    const rec = sink.begin({ ...begin, transport: "grpc", path: "/pkg.Svc/Method" });
    if (!rec) {
      throw new Error("expected a recorder");
    }
    const huge = Buffer.alloc(64, 0x61);
    expect(rec.appendRequest(huge)).toBe(false);
    expect(rec.appendResponse(huge)).toBe(false);
    await rec.finish({
      status: 200,
      grpcStatus: "0",
      durationMs: 3,
      requestId: "grpc-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const call = store.get("grpc-1");
    expect(call?.transport).toBe("grpc");
    expect(call?.request?.truncated).toBe(true);
    expect(call?.response?.truncated).toBe(true);
    expect(call?.request?.encoding).toBe("base64");
    expect(Buffer.from(call?.request?.data ?? "", "base64").length).toBe(32);
  });

  test("inflates gzip-compressed gRPC frames before JSON decode", async () => {
    const store = new TrafficCallRing();
    const sink = new ProxyTrafficSink({
      cfg: () => cfgWithInspect((item) => {
        item.proxy.routes[0] = inspectRoute({ inspect: { enabled: true, max_bytes: 1024 } });
      }),
      store,
    });
    const rec = sink.begin({ ...begin, transport: "grpc", path: "/pkg.Svc/Json" });
    if (!rec) {
      throw new Error("expected a recorder");
    }
    const raw = Buffer.from('{"hello":"gzip"}');
    const gz = Buffer.from(Bun.gzipSync(raw));
    const prefix = Buffer.alloc(5);
    prefix[0] = 1;
    prefix.writeUInt32BE(gz.length, 1);
    const frame = Buffer.concat([prefix, gz]);
    rec.setRequestBody(frame);
    rec.appendResponse(frame);
    await rec.finish({
      status: 200,
      grpcStatus: "0",
      durationMs: 1,
      requestId: "grpc-gz",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const call = store.get("grpc-gz");
    expect(call?.request?.data).toBe(frame.toString("base64"));
    expect(call?.request?.text).toContain("gzip");
    expect(call?.response?.text).toContain("gzip");
  });

  test("rejects a gzip gRPC frame that inflates past inspect.max_bytes", async () => {
    const store = new TrafficCallRing();
    const sink = new ProxyTrafficSink({
      cfg: () => cfgWithInspect((item) => {
        item.proxy.routes[0] = inspectRoute({ inspect: { enabled: true, max_bytes: 32 } });
      }),
      store,
    });
    const rec = sink.begin({ ...begin, transport: "grpc", path: "/pkg.Svc/Bomb" });
    if (!rec) {
      throw new Error("expected a recorder");
    }
    const raw = Buffer.alloc(256, 0x61);
    const gz = Buffer.from(Bun.gzipSync(raw));
    const prefix = Buffer.alloc(5);
    prefix[0] = 1;
    prefix.writeUInt32BE(gz.length, 1);
    const frame = Buffer.concat([prefix, gz]);
    rec.setRequestBody(frame);
    rec.appendResponse(frame);
    await rec.finish({
      status: 200,
      grpcStatus: "0",
      durationMs: 1,
      requestId: "grpc-gz-max",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const call = store.get("grpc-gz-max");
    expect(call?.request?.data).toBe(frame.toString("base64"));
    expect(call?.request?.text).toBeUndefined();
    expect(call?.response?.text).toBeUndefined();
  });

  test("keeps base64 only when a compressed gRPC frame fails to gunzip", async () => {
    const store = new TrafficCallRing();
    const sink = new ProxyTrafficSink({ cfg: () => cfgWithInspect(), store });
    const rec = sink.begin({ ...begin, transport: "grpc", path: "/pkg.Svc/Bad" });
    if (!rec) {
      throw new Error("expected a recorder");
    }
    const prefix = Buffer.alloc(5);
    prefix[0] = 1;
    prefix.writeUInt32BE(3, 1);
    const frame = Buffer.concat([prefix, Buffer.from([0x00, 0x01, 0x02])]);
    rec.setRequestBody(frame);
    rec.appendResponse(frame);
    await rec.finish({
      status: 200,
      grpcStatus: "0",
      durationMs: 1,
      requestId: "grpc-badgz",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const call = store.get("grpc-badgz");
    expect(call?.request?.data).toBe(frame.toString("base64"));
    expect(call?.request?.text).toBeUndefined();
    expect(call?.response?.text).toBeUndefined();
  });

  test("uses a named plugin traffic decoder on both sides and falls back when it returns undefined", async () => {
    const store = new TrafficCallRing();
    const cfg = cfgWithInspect((item) => {
      item.proxy.routes[0] = inspectRoute({
        inspect: { enabled: true, max_bytes: 1024, grpc: { decoder: "temporal" } },
      });
    });
    let fallback = false;
    const sink = new ProxyTrafficSink({
      cfg: () => cfg,
      store,
      decoders: () => [
        {
          name: "temporal",
          decode: ({ path, side, messages }) => {
            if (fallback) {
              return undefined;
            }
            return { plugin: true, path, side, n: messages.length };
          },
        },
      ],
    });
    const rec = sink.begin({ ...begin, transport: "grpc", path: "/temporal.Workflow/Start" });
    if (!rec) {
      throw new Error("expected a recorder");
    }
    const frame = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 2, 0x08, 0x2a]),
    ]);
    rec.setRequestBody(frame);
    rec.appendResponse(frame);
    await rec.finish({
      status: 200,
      grpcStatus: "0",
      durationMs: 1,
      requestId: "grpc-plugin",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const used = store.get("grpc-plugin");
    expect(JSON.parse(used?.request?.text ?? "")).toEqual({
      plugin: true,
      path: "/temporal.Workflow/Start",
      side: "request",
      n: 1,
    });
    expect(JSON.parse(used?.response?.text ?? "")).toEqual({
      plugin: true,
      path: "/temporal.Workflow/Start",
      side: "response",
      n: 1,
    });

    fallback = true;
    const rec2 = sink.begin({ ...begin, transport: "grpc", path: "/temporal.Workflow/Start" });
    if (!rec2) {
      throw new Error("expected a recorder");
    }
    rec2.setRequestBody(frame);
    rec2.appendResponse(frame);
    await rec2.finish({
      status: 200,
      grpcStatus: "0",
      durationMs: 1,
      requestId: "grpc-fallback",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const fell = store.get("grpc-fallback");
    expect(JSON.parse(fell?.request?.text ?? "")).toEqual({ "1": 42 });
    expect(JSON.parse(fell?.response?.text ?? "")).toEqual({ "1": 42 });
  });
});
