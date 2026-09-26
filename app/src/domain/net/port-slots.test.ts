import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyHealth, emptyRouteAuth, emptyService } from "../config/types.ts";
import { listenerPorts, MAX_PORT_SLOTS, pickSlot, shiftConfigPorts, slotOffset } from "./port-slots.ts";

function config() {
  const cfg = defaultConfig();
  cfg.services.api = {
    ...emptyService(),
    ports: [
      { name: "http", value: 18000, auto: false },
      { name: "admin", value: 0, auto: true },
    ],
    health: { ...emptyHealth(), type: "http", url: "http://127.0.0.1:18000/health" },
  };
  cfg.services.db = {
    ...emptyService(),
    ports: [{ name: "db", value: 5432, auto: false }],
    health: { ...emptyHealth(), type: "tcp", address: "localhost:5432" },
  };
  cfg.services.remote = {
    ...emptyService(),
    ports: [{ name: "http", value: 18010, auto: false }],
    health: { ...emptyHealth(), type: "http", url: "https://staging.example.com:18010/health" },
  };
  cfg.proxy.enabled = true;
  cfg.proxy.listen = { host: "127.0.0.1", port: 18080 };
  cfg.proxy.token_endpoint = { enabled: true, host: "127.0.0.1", port: 18090 };
  cfg.proxy.routes = [
    { name: "temporal", transport: "grpc", listen: { host: "127.0.0.1", port: 7233 }, match: { host: "", path: "" }, upstream: { url: "https://t.example.com" }, auth: emptyRouteAuth() },
  ];
  cfg.telemetry.otlp = { enabled: true, listen: { host: "127.0.0.1", port: 18418 } };
  cfg.web = { enabled: true, listen: { host: "127.0.0.1", port: 18900 } };
  return cfg;
}

describe("port slots", () => {
  test("slot 0 changes nothing", () => {
    const cfg = config();
    shiftConfigPorts(cfg, slotOffset(0));
    expect(cfg).toEqual(config());
  });

  test("slot N moves every fixed port and listener by N × 100; auto stays auto", () => {
    const cfg = config();
    shiftConfigPorts(cfg, slotOffset(2));
    expect(cfg.services.api?.ports).toEqual([
      { name: "http", value: 18200, auto: false },
      { name: "admin", value: 0, auto: true },
    ]);
    expect(cfg.services.db?.ports[0]?.value).toBe(5632);
    expect(cfg.proxy.listen.port).toBe(18280);
    expect(cfg.proxy.token_endpoint.port).toBe(18290);
    expect(cfg.proxy.routes[0]?.listen?.port).toBe(7433);
    expect(cfg.telemetry.otlp.listen.port).toBe(18618);
    expect(cfg.web.listen.port).toBe(19100);
  });

  test("a loopback health target at the service's own port follows it; others stay", () => {
    const cfg = config();
    shiftConfigPorts(cfg, 100);
    expect(cfg.services.api?.health.url).toBe("http://127.0.0.1:18100/health");
    expect(cfg.services.db?.health.address).toBe("localhost:5532");
    // Not loopback: a remote dependency's own port isn't ours to move.
    expect(cfg.services.remote?.health.url).toBe("https://staging.example.com:18010/health");
  });

  test("a health target on another port, or a template, is left as written", () => {
    const cfg = config();
    cfg.services.api!.health.url = "http://127.0.0.1:9999/health";
    cfg.services.db!.health.address = "${services.db.ports.db}";
    shiftConfigPorts(cfg, 100);
    expect(cfg.services.api?.health.url).toBe("http://127.0.0.1:9999/health");
    expect(cfg.services.db?.health.address).toBe("${services.db.ports.db}");
  });

  test("unset listeners (port 0) stay unset", () => {
    const cfg = defaultConfig();
    shiftConfigPorts(cfg, 100);
    expect(cfg.proxy.listen.port).toBe(0);
    expect(cfg.proxy.token_endpoint.port).toBe(0);
  });

  test("pickSlot keeps a checkout's slot and otherwise takes the lowest free one", () => {
    const taken = [
      { slot: 0, repoRoot: "/a", claimedAt: "" },
      { slot: 2, repoRoot: "/c", claimedAt: "" },
    ];
    expect(pickSlot(taken, "/c")).toBe(2);
    expect(pickSlot(taken, "/b")).toBe(1);
    const full = Array.from({ length: MAX_PORT_SLOTS }, (_, slot) => ({ slot, repoRoot: `/r${slot}`, claimedAt: "" }));
    expect(pickSlot(full, "/new")).toBeUndefined();
  });

  test("listenerPorts reports only enabled listeners", () => {
    const cfg = config();
    expect(listenerPorts(cfg)).toEqual({ proxy: 18080, web: 18900, otlp: 18418 });
    cfg.web.enabled = false;
    expect(listenerPorts(cfg).web).toBeUndefined();
  });
});
