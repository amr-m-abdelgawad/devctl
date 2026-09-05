import { firstPort, namedPort, type DevctlConfig } from "../../domain/config/types.ts";

export function resolveString(
  value: string,
  cfg: DevctlConfig,
  assigned: Record<string, Record<string, number>>,
): string {
  let remaining = value;
  let out = "";
  for (;;) {
    const start = remaining.indexOf("${");
    if (start < 0) {
      return out + remaining;
    }
    out += remaining.slice(0, start);
    const end = remaining.slice(start).indexOf("}");
    if (end < 0) {
      throw new Error(`unclosed environment reference in "${value}"`);
    }
    const ref = remaining.slice(start + 2, start + end);
    out += resolveRef(ref, cfg, assigned);
    remaining = remaining.slice(start + end + 1);
  }
}

function resolveRef(ref: string, cfg: DevctlConfig, assigned: Record<string, Record<string, number>>): string {
  const parts = ref.split(".");
  if (parts.length < 3 || parts[0] !== "services") {
    throw new Error(`unsupported reference \${${ref}}`);
  }
  const svcName = parts[1] ?? "";
  const svc = cfg.services[svcName];
  if (!svc) {
    throw new Error(`reference \${${ref}}: unknown service`);
  }
  const assignedPorts = assigned[svcName];
  if (parts[2] === "port") {
    if (assignedPorts) {
      if (assignedPorts.http !== undefined) {
        return String(assignedPorts.http);
      }
      const first = Object.values(assignedPorts)[0];
      if (first !== undefined) {
        return String(first);
      }
    }
    const p = firstPort(svc.ports);
    if (p && !p.auto) {
      return String(p.value);
    }
  }
  if (parts[2] === "ports") {
    const name = parts[3];
    if (!name) {
      throw new Error(`reference \${${ref}}: missing port name`);
    }
    if (assignedPorts && assignedPorts[name] !== undefined) {
      return String(assignedPorts[name]);
    }
    const p = namedPort(svc.ports, name);
    if (p && !p.auto) {
      return String(p.value);
    }
    const index = Number.parseInt(name, 10);
    if (!Number.isNaN(index) && index >= 0 && index < svc.ports.length) {
      const indexed = svc.ports[index];
      if (indexed && !indexed.auto) {
        return String(indexed.value);
      }
    }
  }
  throw new Error(`unresolvable reference \${${ref}}`);
}

export function resolveEnvMap(
  input: Record<string, string>,
  cfg: DevctlConfig,
  assigned: Record<string, Record<string, number>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = resolveString(value, cfg, assigned);
  }
  return out;
}

export function findRefs(value: string): string[] {
  const refs: string[] = [];
  let remaining = value;
  for (;;) {
    const start = remaining.indexOf("${");
    if (start < 0) {
      return refs;
    }
    const end = remaining.slice(start).indexOf("}");
    if (end < 0) {
      return refs;
    }
    refs.push(remaining.slice(start + 2, start + end));
    remaining = remaining.slice(start + end + 1);
  }
}

export function refResolvable(ref: string, cfg: DevctlConfig): boolean {
  const parts = ref.split(".");
  if (parts.length < 2) {
    return false;
  }
  if (parts[0] !== "services" || parts.length < 3) {
    return false;
  }
  const svc = cfg.services[parts[1] ?? ""];
  if (!svc) {
    return false;
  }
  if (parts[2] === "port" || parts[2] === "ports") {
    if (parts.length === 3) {
      return svc.ports.length > 0;
    }
    if (parts.length >= 4) {
      const name = parts[3] ?? "";
      if (!Number.isNaN(Number.parseInt(name, 10))) {
        return true;
      }
      return namedPort(svc.ports, name) !== undefined;
    }
  }
  return true;
}
