import { knownCapabilities, SHELL_META_TOKENS } from "./known.ts";
import { isLoopbackBindHost } from "../../domain/net/hosts.ts";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRefs, refResolvable } from "./refs.ts";
import { envRefsIn, isWholeEnvRef } from "../../domain/config/env-ref.ts";
import {
  commandEmpty,
  CurrentVersion,
  effectiveRestartPolicy,
  identityKind,
  isServiceAccountIdentity,
  LOCALHOST,
  RestartAlways,
  RestartNever,
  RestartOnFailure,
  type Command,
  type DevctlConfig,
  type EnvConfig,
  type IdentityConfig,
  type RouteAuthConfig,
  type RouteConfig,
  dependencyName,
  dependencyCondition,
  isGrpcRoute,
  namedPort,
} from "../../domain/config/types.ts";

const MAX_PORT = 65535;
const MIN_PORT = 1;

export const BUILTIN_HEALTH_TYPES = ["http", "tcp", "process", "command"];

// Health types outside BUILTIN_HEALTH_TYPES are only valid if a plugin
// registers a matching health check. validateHealth() can't confirm that —
// plugins load after config validation — so it lets them through when
// cfg.plugins is non-empty; call this once plugins are loaded to confirm
// each such type actually resolved to a registered check.
export function unresolvedHealthTypes(cfg: DevctlConfig): Array<{ service: string; type: string }> {
  const unresolved: Array<{ service: string; type: string }> = [];
  for (const [name, svc] of Object.entries(cfg.services)) {
    const type = svc.health.type;
    if (type !== "" && !BUILTIN_HEALTH_TYPES.includes(type.toLowerCase())) {
      unresolved.push({ service: name, type });
    }
  }
  return unresolved;
}

const unseen = 0;
const active = 1;
const done = 2;

export function validate(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  if (cfg.version === 0) {
    issues.push("version is required");
  } else if (cfg.version !== CurrentVersion) {
    issues.push(`unsupported config version ${cfg.version} (expected ${CurrentVersion}); no migration is available`);
  }
  if (Object.keys(cfg.services).length === 0) {
    issues.push("at least one service must be defined");
  }
  issues.push(...validateServices(cfg));
  issues.push(...validateTasks(cfg));
  issues.push(...validateCycles(cfg));
  issues.push(...validateProfiles(cfg));
  issues.push(...validateProxy(cfg));
  for (const [index, plugin] of cfg.plugins.entries()) {
    if (plugin.path === "") issues.push(`plugins.${index}.path is required`);
    else {
      try {
        const path = plugin.path.startsWith("file:") ? fileURLToPath(plugin.path) : (isAbsolute(plugin.path) ? plugin.path : resolve(cfg.repoRoot, plugin.path));
        if (!existsSync(path)) issues.push(`plugins.${index}.path does not exist: ${plugin.path}`);
      } catch {
        issues.push(`plugins.${index}.path is invalid: ${plugin.path}`);
      }
    }
  }
  if (cfg.logs.max_memory_events < 0) {
    issues.push("logs.max_memory_events must be >= 0");
  }
  return issues;
}

function validateTasks(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  for (const [name, task] of Object.entries(cfg.tasks)) {
    const prefix = `tasks.${name}`;
    if (commandEmpty(task.command)) issues.push(`${prefix}.command is required`);
    issues.push(...validateShellCommand(prefix, task.command, task.shell));
    for (const dep of task.dependencies) if (!cfg.services[dep]) issues.push(`${prefix}.dependencies: unknown service "${dep}"`);
    issues.push(...validateEnvRefs(`${prefix}.environment`, task.environment, cfg));
  }
  return issues;
}

function validateServices(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  const usedPorts: Record<number, string> = {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    const prefix = `services.${name}`;
    if (commandEmpty(svc.command) && !svc.container) {
      issues.push(`${prefix}.command is required`);
    }
    issues.push(...validateShellCommand(prefix, svc.command, svc.shell));
    issues.push(...validateShellCommand(`${prefix}.hooks.pre_start`, svc.hooks.pre_start, svc.shell));
    issues.push(...validateShellCommand(`${prefix}.hooks.post_start`, svc.hooks.post_start, svc.shell));
    issues.push(...validateCapabilities(prefix, svc.capabilities));
    for (const dependency of svc.dependencies) {
      const dep = dependencyName(dependency);
      if (!cfg.services[dep]) {
        issues.push(`${prefix}.dependencies: unknown service "${dep}"`);
      }
      if (dep === name) {
        issues.push(`${prefix}.dependencies: service cannot depend on itself`);
      }
      if (!['service_started', 'service_healthy'].includes(dependencyCondition(dependency))) issues.push(`${prefix}.dependencies: condition must be service_started or service_healthy`);
      if (dependencyCondition(dependency) === "service_healthy" && cfg.services[dep]?.health.type === "") issues.push(`${prefix}.dependencies: service_healthy requires ${dep} to define a health check`);
    }
    if (svc.extends !== "" && !cfg.templates[svc.extends]) {
      issues.push(`${prefix}.extends: unknown template "${svc.extends}"`);
    }
    for (const port of svc.ports.filter((p) => !p.auto)) {
      if (port.value < MIN_PORT || port.value > MAX_PORT) {
        issues.push(`${prefix}.ports.${port.name}: invalid port ${port.value}`);
      } else if (usedPorts[port.value]) {
        issues.push(`duplicate port ${port.value} used by ${usedPorts[port.value]} and ${name}`);
      } else {
        usedPorts[port.value] = name;
      }
    }
    const identErr = validateIdentity(`${prefix}.identity`, svc.identity, cfg.plugins.length > 0);
    if (identErr !== "") {
      issues.push(identErr);
    }
    issues.push(...validateHealth(prefix, svc, cfg.plugins.length > 0));
    if (svc.health.start_period_seconds < 0) issues.push(`${prefix}.health.start_period_seconds must be >= 0`);
    if (svc.health.unhealthy_threshold < 1) issues.push(`${prefix}.health.unhealthy_threshold must be >= 1`);
    if (svc.health.healthy_reset_threshold < 1) issues.push(`${prefix}.health.healthy_reset_threshold must be >= 1`);
    const policy = effectiveRestartPolicy(svc.restart);
    if (policy !== RestartNever && policy !== RestartOnFailure && policy !== RestartAlways) {
      issues.push(`${prefix}.restart.policy must be never, on_failure, or always`);
    }
    issues.push(...validateEnvRefs(`${prefix}.environment`, svc.environment, cfg));
    if (svc.container) {
      if (svc.container.image === "") issues.push(`${prefix}.container.image is required`);
      if (svc.container.runtime !== "" && svc.container.runtime !== "docker" && svc.container.runtime !== "podman") {
        issues.push(`${prefix}.container.runtime must be docker or podman`);
      }
      for (const [portName, target] of Object.entries(svc.container.ports)) {
        if (!svc.ports.some((port) => port.name === portName)) issues.push(`${prefix}.container.ports.${portName}: no matching service port`);
        if (target < MIN_PORT || target > MAX_PORT) issues.push(`${prefix}.container.ports.${portName}: invalid container port ${target}`);
      }
    }
  }
  return issues;
}

function validateHealth(
  prefix: string,
  svc: { health: { type: string; url: string; address: string; command: { args: string[] } }; ports: unknown[] },
  pluginsConfigured: boolean,
): string[] {
  const issues: string[] = [];
  if (svc.health.type === "") {
    return issues;
  }
  const kind = svc.health.type.toLowerCase();
  // A plugin can register a custom health check type, but plugins load
  // after config validation, so their names aren't known here. Defer the
  // final say to the supervisor (see Supervisor.run), which re-checks any
  // non-builtin type against the loaded plugin registry once it's ready.
  if (!BUILTIN_HEALTH_TYPES.includes(kind) && !pluginsConfigured) {
    issues.push(`${prefix}.health.type must be http, tcp, process, or command`);
  }
  if (kind === "http" && svc.health.url === "") {
    issues.push(`${prefix}.health.url is required for http health checks`);
  }
  if (kind === "tcp" && svc.health.address === "" && svc.ports.length === 0) {
    issues.push(`${prefix}.health.address is required for tcp health checks without ports`);
  }
  if (kind === "command" && commandEmpty({ args: svc.health.command.args, shell: false })) {
    issues.push(`${prefix}.health.command is required for command health checks`);
  }
  return issues;
}

// Types outside this set are only valid if a plugin registers a matching
// identity provider. Like health.type, that can't be confirmed here —
// plugins load after config validation — so it's let through when
// cfg.plugins is non-empty; Supervisor.run() re-checks it once plugins are
// loaded (see checkPluginIdentityTypes).
export const BUILTIN_IDENTITY_KINDS = ["", "user", "service", "service_account"];

function validateIdentity(prefix: string, ident: IdentityConfig, pluginsConfigured: boolean): string {
  const kind = identityKind(ident).toLowerCase();
  if (kind === "" || kind === "user") {
    return "";
  }
  if (kind === "service" || kind === "service_account") {
    if (ident.service_account === "") {
      return `${prefix}.service_account is required for service identity`;
    }
    if (!ident.service_account.includes("@")) {
      return `${prefix}.service_account must be an email`;
    }
    return "";
  }
  if (pluginsConfigured) {
    return "";
  }
  return `${prefix}.type must be user or service_account`;
}

export function unresolvedIdentityTypes(cfg: DevctlConfig): Array<{ service: string; type: string }> {
  const unresolved: Array<{ service: string; type: string }> = [];
  for (const [name, svc] of Object.entries(cfg.services)) {
    const kind = identityKind(svc.identity).toLowerCase();
    if (!BUILTIN_IDENTITY_KINDS.includes(kind)) {
      unresolved.push({ service: name, type: kind });
    }
  }
  return unresolved;
}

function validateCycles(cfg: DevctlConfig): string[] {
  const state: Record<string, number> = {};
  const issues: string[] = [];
  const stack: string[] = [];
  const visit = (name: string): void => {
    const current = state[name] ?? unseen;
    if (current === done) {
      return;
    }
    if (current === active) {
      issues.push(`dependency cycle: ${[...stack, name].join(" → ")}`);
      return;
    }
    state[name] = active;
    stack.push(name);
    const svc = cfg.services[name];
    if (svc) {
      for (const dependency of svc.dependencies) {
        const dep = dependencyName(dependency);
        if (cfg.services[dep]) {
          visit(dep);
        }
      }
    }
    stack.pop();
    state[name] = done;
  };
  for (const name of Object.keys(cfg.services)) {
    visit(name);
  }
  return issues;
}

function validateEnvRefs(prefix: string, env: EnvConfig, cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  const check = (key: string, value: string): void => {
    for (const ref of findRefs(value)) {
      if (!refResolvable(ref, cfg)) {
        issues.push(`${prefix}.${key}: unresolvable reference \${${ref}}`);
      }
    }
  };
  for (const [key, value] of Object.entries(env.vars)) {
    check(key, value);
  }
  for (const [key, value] of Object.entries(env.defaults)) {
    check(key, value);
  }
  return issues;
}

function validateProfiles(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  for (const [name, profile] of Object.entries(cfg.profiles)) {
    for (const svc of profile.services) {
      if (!cfg.services[svc]) {
        issues.push(`profiles.${name} references unknown service "${svc}"`);
      }
    }
  }
  return issues;
}

function validateProxy(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  if (cfg.proxy.listen.host !== "") {
    if (!isHost(cfg.proxy.listen.host)) {
      issues.push("proxy.listen.host must be an IP address or localhost");
    } else if (!isLoopbackBindHost(cfg.proxy.listen.host)) {
      issues.push("proxy.listen.host must be a loopback address");
    }
  }
  if (cfg.proxy.enabled && cfg.proxy.listen.port === 0) {
    issues.push("proxy.listen.port is required when proxy.enabled is true");
  }
  if (cfg.proxy.listen.port !== 0 && (cfg.proxy.listen.port < MIN_PORT || cfg.proxy.listen.port > MAX_PORT)) {
    issues.push("proxy.listen.port is invalid");
  }
  const seenRoutes: Record<string, boolean> = {};
  const seenGrpcPorts = new Set<number>();
  cfg.proxy.routes.forEach((route, i) => {
    const prefix = `proxy.routes[${i}]`;
    if (route.name === "") {
      issues.push(`${prefix}.name is required`);
    } else if (seenRoutes[route.name]) {
      issues.push(`${prefix}: duplicate route name ${route.name}`);
    }
    seenRoutes[route.name] = true;
    const transport = (route.transport ?? "").toLowerCase();
    if (transport !== "" && transport !== "http" && transport !== "grpc") {
      issues.push(`${prefix}.transport must be "http" or "grpc"`);
    }
    issues.push(...validateRouteUpstream(route, prefix, cfg));
    issues.push(...validateRouteAuth(route, prefix));
    if (isGrpcRoute(route)) {
      issues.push(...validateGrpcRoute(route, prefix, seenGrpcPorts, cfg));
    }
  });
  issues.push(...validateTokenEndpoint(cfg));
  return issues;
}

// A grpc route is a dedicated loopback HTTP/2 listener forwarding to one TLS
// upstream, so it needs its own valid loopback port (distinct from the HTTP
// proxy and every other grpc route) and an https upstream (the IAP leg is TLS).
function validateGrpcRoute(route: RouteConfig, prefix: string, seenPorts: Set<number>, cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  const listen = route.listen;
  if (!listen || listen.port === 0) {
    issues.push(`${prefix}.listen.port is required for a grpc route`);
  } else {
    if (listen.port < MIN_PORT || listen.port > MAX_PORT) {
      issues.push(`${prefix}.listen.port is invalid`);
    }
    if (seenPorts.has(listen.port)) {
      issues.push(`${prefix}.listen.port ${listen.port} is already used by another grpc route`);
    }
    seenPorts.add(listen.port);
    if (listen.port === cfg.proxy.listen.port) {
      issues.push(`${prefix}.listen.port must differ from proxy.listen.port`);
    }
    if (cfg.proxy.token_endpoint.enabled && listen.port === cfg.proxy.token_endpoint.port) {
      issues.push(`${prefix}.listen.port must differ from proxy.token_endpoint.port`);
    }
    if (listen.host !== "" && (!isHost(listen.host) || !isLoopbackBindHost(listen.host))) {
      issues.push(`${prefix}.listen.host must be a loopback address`);
    }
  }
  if (!(route.upstream.url ?? "").trim().toLowerCase().startsWith("https://")) {
    issues.push(`${prefix}.upstream.url must be an https:// address for a grpc route`);
  }
  // A grpc route has its own dedicated listener; host/path matching does not
  // apply, so a `match` here would be silently ignored — reject it instead.
  if (route.match.host !== "" || route.match.path !== "") {
    issues.push(`${prefix}.match is not supported on a grpc route`);
  }
  // response_headers is applied by the HTTP proxy path only.
  if (route.response_headers && Object.keys(route.response_headers).length > 0) {
    issues.push(`${prefix}.response_headers is not supported on a grpc route`);
  }
  return issues;
}

// A route addresses its upstream by a literal url (hand-written) or by a
// service + port reference (synthesized from expose/gateway, resolved to the
// live port at request time). Exactly one is required; a service reference
// must name a real service and an existing port — which also catches an
// `expose` on a service that has no matching (default "http") port.
function validateRouteUpstream(route: RouteConfig, prefix: string, cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  const hasUrl = route.upstream.url !== "";
  const svcName = route.upstream.service ?? "";
  if (svcName === "") {
    if (!hasUrl) {
      issues.push(`${prefix}.upstream requires either url or service`);
    }
    return issues;
  }
  const svc = cfg.services[svcName];
  if (!svc) {
    issues.push(`${prefix}.upstream.service references unknown service ${svcName}`);
    return issues;
  }
  const portName = route.upstream.port || "http";
  if (namedPort(svc.ports, portName) === undefined) {
    issues.push(`${prefix}.upstream: service ${svcName} has no port named ${portName}`);
  }
  return issues;
}

function validateRouteAuth(route: RouteConfig, prefix: string): string[] {
  const issues: string[] = [];
  if (route.auth.type.toLowerCase() === "iap") {
    if (route.auth.audience.trim() === "") {
      issues.push(`${prefix}.auth.audience is required when auth.type is iap`);
    }
    if (route.auth.identity.type.trim() === "") {
      issues.push(`${prefix}.auth.identity.type is required when auth.type is iap`);
    }
  }
  issues.push(...validateIapOAuthClient(route.auth, prefix));
  const identType = route.auth.identity.type.toLowerCase();
  if (identType === "service" || identType === "service_account" || isServiceAccountIdentity({ type: identType, mode: "", service_account: "" })) {
    const sa = route.auth.identity.service_account || route.auth.service_account;
    if (sa === "") {
      issues.push(`${prefix}.auth.identity.service_account is required`);
    }
  }
  return issues;
}

function validateIapOAuthClient(auth: RouteAuthConfig, prefix: string): string[] {
  const clientId = (auth.client_id ?? "").trim();
  const secret = (auth.client_secret ?? "").trim();
  const cred = (auth.credentials ?? "").trim();
  if (clientId === "" && secret === "" && cred === "") {
    return [];
  }
  if (auth.type.toLowerCase() !== "iap") {
    const field = clientId !== "" ? "client_id" : secret !== "" ? "client_secret" : "credentials";
    return [`${prefix}.auth.${field} is only valid when auth.type is iap`];
  }
  const issues: string[] = [];
  if (clientId === "") {
    if (secret !== "") {
      issues.push(`${prefix}.auth.client_id is required when client_secret is set`);
    }
    if (cred !== "") {
      issues.push(`${prefix}.auth.credentials requires auth.client_id`);
    }
    return issues;
  }
  // A credentials file can supply the client_secret, so an inline one is only
  // required when no file is set.
  if (secret === "" && cred === "") {
    issues.push(`${prefix}.auth.client_secret is required when client_id is set`);
  } else if (secret !== "" && envRefsIn(secret).length > 0 && !isWholeEnvRef(secret)) {
    // A pure literal is fine; a value that carries an environment reference
    // must be exactly ${NAME} / ${env.NAME}. A mixed value like `pre-${SECRET}`
    // would interpolate to a half-literal token — reject it up front.
    issues.push(`${prefix}.auth.client_secret must be a literal or a single \${NAME} / \${env.NAME} reference`);
  }
  const identType = auth.identity.type.toLowerCase();
  if (identType === "service" || identType === "service_account") {
    issues.push(`${prefix}.auth.client_id is only valid with identity.type user`);
  }
  return issues;
}

function validateTokenEndpoint(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  const ep = cfg.proxy.token_endpoint;
  if (!ep.enabled) {
    return issues;
  }
  const host = ep.host || LOCALHOST;
  if (!isLoopbackBindHost(host)) {
    issues.push("proxy.token_endpoint.host must be a loopback address");
  }
  if (ep.port !== 0 && (ep.port < MIN_PORT || ep.port > MAX_PORT)) {
    issues.push("proxy.token_endpoint.port is invalid");
  }
  return issues;
}

function validateShellCommand(prefix: string, command: Command, serviceShell: boolean): string[] {
  if (command.shell || serviceShell) {
    return [];
  }
  for (const arg of command.args) {
    if (SHELL_META_TOKENS.includes(arg) || arg.includes("|") || arg.includes(";") || arg.includes("&&")) {
      return [`${prefix}.command contains shell metacharacters; set shell: true to run via a shell`];
    }
  }
  return [];
}

function validateCapabilities(prefix: string, caps: string[]): string[] {
  const issues: string[] = [];
  for (const cap of caps) {
    if (!knownCapabilities.includes(cap)) {
      issues.push(`${prefix}.capabilities: unknown capability "${cap}"`);
    }
  }
  return issues;
}

function isHost(host: string): boolean {
  if (host === "localhost") {
    return true;
  }
  return netIsIP(host);
}

function netIsIP(host: string): boolean {
  const v4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (v4.test(host)) {
    return host.split(".").every((part) => {
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }
  return host.includes(":");
}
