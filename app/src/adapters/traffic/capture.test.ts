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
});
