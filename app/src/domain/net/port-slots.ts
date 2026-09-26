import type { DevctlConfig, HealthCheckConfig, ListenConfig, PortSpec } from "../config/types.ts";

// Parallel stacks (#117): each checkout running at the same time takes a
// numbered slot. Slot 0 keeps the configured ports; slot N moves every fixed
// port and listener up by N × PORT_SLOT_STRIDE, so N stacks of one config run
// side by side without anyone editing ports.
export const PORT_SLOT_STRIDE = 100;
export const MAX_PORT_SLOTS = 9;

export type InstanceSlot = {
  slot: number;
  repoRoot: string;
  claimedAt: string;
  // Listener ports the stack ran with, recorded by its supervisor for
  // `devctl instances`. Absent until one has started in that slot.
  ports?: Record<string, number>;
};

export function slotOffset(slot: number): number {
  return slot > 0 ? slot * PORT_SLOT_STRIDE : 0;
}

/** The lowest slot no other checkout holds, or undefined when all are taken. */
export function pickSlot(instances: readonly InstanceSlot[], repoRoot: string): number | undefined {
  const own = instances.find((entry) => entry.repoRoot === repoRoot);
  if (own) {
    return own.slot;
  }
  const taken = new Set(instances.map((entry) => entry.slot));
  for (let slot = 0; slot < MAX_PORT_SLOTS; slot += 1) {
    if (!taken.has(slot)) {
      return slot;
    }
  }
  return undefined;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Moves every fixed port and listener by `offset`: fixed service ports (the
 * host side; `container.ports` are the container side and stay), the proxy,
 * token endpoint, gRPC route listeners, the OTLP receiver and the web
 * console. `auto` ports stay auto. A health `url` / `address` on a loopback
 * host at one of the service's own fixed ports follows its port.
 * `${services.…}` references resolve from the shifted values on their own.
 */
export function shiftConfigPorts(cfg: DevctlConfig, offset: number): void {
  if (offset <= 0) {
    return;
  }
  for (const svc of Object.values(cfg.services)) {
    const own = new Set(fixedPorts(svc.ports));
    svc.ports = svc.ports.map((port) => (port.auto || port.value <= 0 ? port : { ...port, value: port.value + offset }));
    svc.health = shiftHealth(svc.health, own, offset);
  }
  shiftListen(cfg.proxy.listen, offset);
  if (cfg.proxy.token_endpoint.port > 0) {
    cfg.proxy.token_endpoint = { ...cfg.proxy.token_endpoint, port: cfg.proxy.token_endpoint.port + offset };
  }
  for (const route of cfg.proxy.routes) {
    if (route.listen) {
      shiftListen(route.listen, offset);
    }
  }
  shiftListen(cfg.telemetry.otlp.listen, offset);
  shiftListen(cfg.web.listen, offset);
}

/** The listener ports a stack binds, for `devctl instances`. */
export function listenerPorts(cfg: DevctlConfig): Record<string, number> {
  const out: Record<string, number> = {};
  if (cfg.proxy.enabled && cfg.proxy.listen.port > 0) {
    out.proxy = cfg.proxy.listen.port;
  }
  if (cfg.web.enabled && cfg.web.listen.port > 0) {
    out.web = cfg.web.listen.port;
  }
  if (cfg.telemetry.otlp.enabled && cfg.telemetry.otlp.listen.port > 0) {
    out.otlp = cfg.telemetry.otlp.listen.port;
  }
  return out;
}

function fixedPorts(ports: readonly PortSpec[]): number[] {
  return ports.filter((port) => !port.auto && port.value > 0).map((port) => port.value);
}

function shiftListen(listen: ListenConfig, offset: number): void {
  if (listen.port > 0) {
    listen.port += offset;
  }
}

function shiftHealth(health: HealthCheckConfig, own: ReadonlySet<number>, offset: number): HealthCheckConfig {
  if (own.size === 0) {
    return health;
  }
  return { ...health, url: shiftLoopbackUrl(health.url, own, offset), address: shiftLoopbackAddress(health.address, own, offset) };
}

function shiftLoopbackUrl(url: string, own: ReadonlySet<number>, offset: number): string {
  if (url === "" || url.includes("${")) {
    return url;
  }
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    if (!LOOPBACK_HOSTS.has(parsed.hostname) || !own.has(port)) {
      return url;
    }
    return url.replace(`${parsed.hostname}:${port}`, `${parsed.hostname}:${port + offset}`);
  } catch {
    return url;
  }
}

function shiftLoopbackAddress(address: string, own: ReadonlySet<number>, offset: number): string {
  if (address === "" || address.includes("${")) {
    return address;
  }
  const colon = address.lastIndexOf(":");
  if (colon <= 0) {
    return address;
  }
  const host = address.slice(0, colon);
  const port = Number(address.slice(colon + 1));
  if (!LOOPBACK_HOSTS.has(host) || !own.has(port)) {
    return address;
  }
  return `${host}:${port + offset}`;
}
