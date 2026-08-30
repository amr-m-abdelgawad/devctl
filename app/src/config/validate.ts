import { knownCapabilities, SHELL_META_TOKENS } from "./known.ts";
import { findRefs, refResolvable } from "./refs.ts";
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
} from "./types.ts";

const MAX_PORT = 65535;
const MIN_PORT = 1;

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
  issues.push(...validateCycles(cfg));
  issues.push(...validateProfiles(cfg));
  issues.push(...validateProxy(cfg));
  if (cfg.logs.max_memory_events < 0) {
    issues.push("logs.max_memory_events must be >= 0");
  }
  return issues;
}

function validateServices(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  const usedPorts: Record<number, string> = {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    const prefix = `services.${name}`;
    if (commandEmpty(svc.command)) {
      issues.push(`${prefix}.command is required`);
    }
    issues.push(...validateShellCommand(prefix, svc.command, svc.shell));
    issues.push(...validateCapabilities(prefix, svc.capabilities));
    for (const dep of svc.dependencies) {
      if (!cfg.services[dep]) {
        issues.push(`${prefix}.dependencies: unknown service "${dep}"`);
      }
      if (dep === name) {
        issues.push(`${prefix}.dependencies: service cannot depend on itself`);
      }
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
    const identErr = validateIdentity(`${prefix}.identity`, svc.identity);
    if (identErr !== "") {
      issues.push(identErr);
    }
    issues.push(...validateHealth(prefix, svc));
    const policy = effectiveRestartPolicy(svc.restart);
    if (policy !== RestartNever && policy !== RestartOnFailure && policy !== RestartAlways) {
      issues.push(`${prefix}.restart.policy must be never, on_failure, or always`);
    }
    issues.push(...validateEnvRefs(`${prefix}.environment`, svc.environment, cfg));
  }
  return issues;
}

function validateHealth(prefix: string, svc: { health: { type: string; url: string; address: string; command: { args: string[] } }; ports: unknown[] }): string[] {
  const issues: string[] = [];
  if (svc.health.type === "") {
    return issues;
  }
  const kind = svc.health.type.toLowerCase();
  if (kind !== "http" && kind !== "tcp" && kind !== "process" && kind !== "command") {
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

function validateIdentity(prefix: string, ident: IdentityConfig): string {
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
  return `${prefix}.type must be user or service_account`;
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
      for (const dep of svc.dependencies) {
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
  if (cfg.proxy.listen.host !== "" && !isHost(cfg.proxy.listen.host)) {
    issues.push("proxy.listen.host must be an IP address or localhost");
  }
  if (cfg.proxy.enabled && cfg.proxy.listen.port === 0) {
    issues.push("proxy.listen.port is required when proxy.enabled is true");
  }
  if (cfg.proxy.listen.port !== 0 && (cfg.proxy.listen.port < MIN_PORT || cfg.proxy.listen.port > MAX_PORT)) {
    issues.push("proxy.listen.port is invalid");
  }
  const seenRoutes: Record<string, boolean> = {};
  cfg.proxy.routes.forEach((route, i) => {
    const prefix = `proxy.routes[${i}]`;
    if (route.name === "") {
      issues.push(`${prefix}.name is required`);
    } else if (seenRoutes[route.name]) {
      issues.push(`${prefix}: duplicate route name ${route.name}`);
    }
    seenRoutes[route.name] = true;
    if (route.upstream.url === "") {
      issues.push(`${prefix}.upstream.url is required`);
    }
    if (route.auth.type.toLowerCase() === "iap") {
      if (route.auth.audience.trim() === "") {
        issues.push(`${prefix}.auth.audience is required when auth.type is iap`);
      }
      if (route.auth.identity.type.trim() === "") {
        issues.push(`${prefix}.auth.identity.type is required when auth.type is iap`);
      }
    }
    const identType = route.auth.identity.type.toLowerCase();
    if (identType === "service" || identType === "service_account" || isServiceAccountIdentity({ type: identType, mode: "", service_account: "" })) {
      const sa = route.auth.identity.service_account || route.auth.service_account;
      if (sa === "") {
        issues.push(`${prefix}.auth.identity.service_account is required`);
      }
    }
  });
  issues.push(...validateTokenEndpoint(cfg));
  return issues;
}

function validateTokenEndpoint(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  const ep = cfg.proxy.token_endpoint;
  if (!ep.enabled) {
    return issues;
  }
  const host = ep.host || LOCALHOST;
  if (host === "0.0.0.0") {
    issues.push("proxy.token_endpoint.host must be a loopback address");
  } else if (host !== "" && host !== LOCALHOST && host !== "localhost" && !host.startsWith("127.")) {
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
