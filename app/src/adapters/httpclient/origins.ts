import { firstPort, type DevctlConfig } from "../../domain/config/types.ts";
import { assignedPorts } from "../http/assigned-ports.ts";

export function knownServiceHosts(cfg: DevctlConfig, live: Map<string, Record<string, number>>): string[] {
  const assigned = assignedPorts(cfg, live);
  const hosts: string[] = [];
  for (const [name, svc] of Object.entries(cfg.services)) {
    const ports = assigned[name] ?? {};
    for (const port of svc.ports) {
      const value = ports[port.name] ?? (port.auto ? undefined : port.value);
      if (value !== undefined) {
        hosts.push(`127.0.0.1:${value}`);
      }
    }
    const fallback = firstPort(svc.ports);
    if (fallback && !fallback.auto && ports[fallback.name] === undefined) {
      hosts.push(`127.0.0.1:${fallback.value}`);
    }
    if (cfg.proxy.enabled) {
      for (const route of cfg.proxy.routes) {
        if (route.upstream.service === name) {
          const host = route.match.host || "127.0.0.1";
          hosts.push(`${host}:${cfg.proxy.listen.port}`);
        }
      }
    }
  }
  return [...new Set(hosts)];
}

export function serviceNameForUrl(url: string, cfg: DevctlConfig, live: Map<string, Record<string, number>>): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const assigned = assignedPorts(cfg, live);
  const host = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? "443" : "80") : parsed.port;
  for (const [name, svc] of Object.entries(cfg.services)) {
    const ports = assigned[name] ?? {};
    for (const spec of svc.ports) {
      const value = ports[spec.name] ?? (spec.auto ? undefined : spec.value);
      if (value !== undefined && host === "127.0.0.1" && String(value) === port) {
        return name;
      }
    }
    if (cfg.proxy.enabled) {
      for (const route of cfg.proxy.routes) {
        if (route.upstream.service !== name) {
          continue;
        }
        const routeHost = route.match.host || "127.0.0.1";
        if (routeHost === parsed.hostname && String(cfg.proxy.listen.port) === port) {
          return name;
        }
      }
    }
  }
  return undefined;
}
