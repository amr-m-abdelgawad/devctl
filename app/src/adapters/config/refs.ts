import { findTemplateRefs } from "../../domain/config/env-ref.ts";
import { httpOutputDefined, isProcessEnvRef, parseHttpRef, processEnvName } from "../../domain/http/recipes.ts";
import { firstPort, namedPort, type DevctlConfig, type HealthCheckConfig, type ServiceConfig } from "../../domain/config/types.ts";

export type HttpValueMap = Record<string, Record<string, string>>;

export type ResolveExtras = {
  http?: HttpValueMap;
  token?: string;
  processEnv?: Record<string, string | undefined>;
};

// The direct loopback port for a service: an assigned http port, else the
// first assigned port, else a declared non-auto port. Undefined when only an
// auto port is declared and nothing has been assigned yet.
function directPort(svc: ServiceConfig, assignedPorts?: Record<string, number>): number | undefined {
  if (assignedPorts) {
    if (assignedPorts.http !== undefined) {
      return assignedPorts.http;
    }
    const first = Object.values(assignedPorts)[0];
    if (first !== undefined) {
      return first;
    }
  }
  const p = firstPort(svc.ports);
  if (p && !p.auto) {
    return p.value;
  }
  return undefined;
}

export function resolveString(
  value: string,
  cfg: DevctlConfig,
  assigned: Record<string, Record<string, number>>,
  userEmail = "",
  extras: ResolveExtras = {},
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
    out += resolveRef(ref, cfg, assigned, userEmail, extras);
    remaining = remaining.slice(start + end + 1);
  }
}

function resolveRef(
  ref: string,
  cfg: DevctlConfig,
  assigned: Record<string, Record<string, number>>,
  userEmail: string,
  extras: ResolveExtras,
): string {
  const parts = ref.split(".");
  if (ref === "token") {
    if (extras.token === undefined) {
      throw new Error(`unsupported reference \${${ref}}`);
    }
    return extras.token;
  }
  if (parts[0] === "identity") {
    if (parts.length === 2 && parts[1] === "user") {
      return userEmail;
    }
    throw new Error(`unsupported reference \${${ref}}`);
  }
  if (parts[0] === "http") {
    return resolveHttpRef(ref, extras.http);
  }
  if (parts[0] === "services") {
    return resolveServiceRef(ref, parts, cfg, assigned);
  }
  if (extras.processEnv && isProcessEnvRef(ref)) {
    const name = processEnvName(ref);
    const resolved = extras.processEnv[name];
    if (resolved === undefined || resolved === "") {
      throw new Error(`unresolvable reference \${${ref}}: environment ${name} is empty`);
    }
    return resolved;
  }
  throw new Error(`unsupported reference \${${ref}}`);
}

function resolveHttpRef(ref: string, http: HttpValueMap | undefined): string {
  const parsed = parseHttpRef(ref);
  if (!parsed) {
    throw new Error(`unsupported reference \${${ref}}`);
  }
  const values = http?.[parsed.recipe];
  if (!values || values[parsed.output] === undefined) {
    throw new Error(`unresolvable reference \${${ref}}`);
  }
  return values[parsed.output] ?? "";
}

function resolveServiceRef(
  ref: string,
  parts: string[],
  cfg: DevctlConfig,
  assigned: Record<string, Record<string, number>>,
): string {
  if (parts.length < 3) {
    throw new Error(`unsupported reference \${${ref}}`);
  }
  const svcName = parts[1] ?? "";
  const svc = cfg.services[svcName];
  if (!svc) {
    throw new Error(`reference \${${ref}}: unknown service`);
  }
  const assignedPorts = assigned[svcName];
  // `.host` / `.url` give a stable logical address for a service. When the
  // proxy is enabled and the service is exposed through it (a synthesized
  // route references the service), they resolve to the proxy's entry address
  // — a fixed host:port that survives the target moving to a new upstream
  // port. Otherwise they resolve to the direct loopback address, which is a
  // startup snapshot just like `.port`.
  if (parts[2] === "host" || parts[2] === "url") {
    const hubRoute = cfg.proxy.enabled ? cfg.proxy.routes.find((route) => route.upstream.service === svcName) : undefined;
    if (parts[2] === "host") {
      return hubRoute ? hubRoute.match.host || "127.0.0.1" : "127.0.0.1";
    }
    if (hubRoute) {
      const host = hubRoute.match.host || "127.0.0.1";
      return `http://${host}:${cfg.proxy.listen.port}${hubRoute.match.path}`;
    }
    const direct = directPort(svc, assignedPorts);
    if (direct === undefined) {
      throw new Error(`unresolvable reference \${${ref}}`);
    }
    return `http://127.0.0.1:${direct}`;
  }
  if (parts[2] === "port") {
    const direct = directPort(svc, assignedPorts);
    if (direct !== undefined) {
      return String(direct);
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
  userEmail = "",
  extras: ResolveExtras = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = resolveString(value, cfg, assigned, userEmail, extras);
  }
  return out;
}

// Health fields that accept `${services.<name>.…}` templates.
export const HEALTH_TEMPLATE_FIELDS = ["url", "address"] as const;

// Expands `${services.<name>.…}` in health.url and health.address for one
// service's probe. `running` holds the ports assigned to running services;
// `own` (this service's assigned ports) wins for its own references, and
// fixed ports fill in for services that aren't running. Each map follows the
// service's declared port order, so `.port` picks the first declared port.
export function resolveHealthConfig(
  health: HealthCheckConfig,
  cfg: DevctlConfig,
  service: string,
  own: Record<string, number>,
  running: ReadonlyMap<string, Record<string, number>> = new Map(),
): HealthCheckConfig {
  if (!HEALTH_TEMPLATE_FIELDS.some((field) => health[field].includes("${"))) {
    return health;
  }
  const assigned: Record<string, Record<string, number>> = {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    const live = name === service ? { ...running.get(name), ...own } : running.get(name) ?? {};
    const ports: Record<string, number> = {};
    for (const p of svc.ports) {
      const value = live[p.name] ?? (p.auto ? undefined : p.value);
      if (value !== undefined) {
        ports[p.name] = value;
      }
    }
    assigned[name] = { ...ports, ...live };
  }
  const resolved = { ...health };
  for (const field of HEALTH_TEMPLATE_FIELDS) {
    try {
      resolved[field] = resolveString(health[field], cfg, assigned);
    } catch (err) {
      throw new Error(`health.${field}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return resolved;
}

// Whether `${ref}` in a health field can expand at probe time: exactly the
// `services.<name>.port|host|url` and `.ports.<name|index>` forms the resolver
// accepts. An index must name a fixed port (assigned ports are keyed by name).
export function healthRefResolvable(ref: string, cfg: DevctlConfig): boolean {
  const [root, svcName = "", kind = "", portName, ...rest] = ref.split(".");
  const svc = cfg.services[svcName];
  if (root !== "services" || !svc || rest.length > 0) {
    return false;
  }
  if (portName === undefined) {
    if (kind === "host") {
      return true;
    }
    if (kind === "url") {
      return svc.ports.length > 0 || (cfg.proxy.enabled && cfg.proxy.routes.some((route) => route.upstream.service === svcName));
    }
    return kind === "port" && svc.ports.length > 0;
  }
  if (kind !== "ports") {
    return false;
  }
  if (namedPort(svc.ports, portName)) {
    return true;
  }
  const index = /^\d+$/.test(portName) ? Number(portName) : -1;
  const indexed = svc.ports[index];
  return indexed !== undefined && !indexed.auto;
}

export function findRefs(value: string): string[] {
  return findTemplateRefs(value);
}

export function refResolvable(ref: string, cfg: DevctlConfig, opts: { allowProcessEnv?: boolean; allowToken?: boolean } = {}): boolean {
  const parts = ref.split(".");
  if (parts.length < 1) {
    return false;
  }
  if (ref === "token") {
    return opts.allowToken === true;
  }
  if (parts[0] === "identity") {
    return parts.length === 2 && parts[1] === "user";
  }
  if (parts[0] === "http") {
    const parsed = parseHttpRef(ref);
    return parsed !== undefined && httpOutputDefined(cfg, parsed.recipe, parsed.output);
  }
  if (opts.allowProcessEnv && isProcessEnvRef(ref)) {
    return true;
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
