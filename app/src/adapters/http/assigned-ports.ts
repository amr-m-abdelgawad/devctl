import type { DevctlConfig } from "../../domain/config/types.ts";

export function assignedPorts(cfg: DevctlConfig, live: Map<string, Record<string, number>>): Record<string, Record<string, number>> {
  const assigned: Record<string, Record<string, number>> = {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    const ports: Record<string, number> = {};
    for (const port of svc.ports) {
      if (!port.auto) {
        ports[port.name] = port.value;
      }
    }
    const livePorts = live.get(name);
    if (livePorts) {
      Object.assign(ports, livePorts);
    }
    assigned[name] = ports;
  }
  return assigned;
}
