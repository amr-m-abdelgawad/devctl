import { commandEmpty, emptyService, identityKind, type DevctlConfig, type EnvConfig, type ProfileConfig, type ServiceConfig } from "./types.ts";

export function mergeConfig(base: DevctlConfig, overlay: DevctlConfig): DevctlConfig {
  const out: DevctlConfig = {
    ...base,
    project: { name: overlay.project.name || base.project.name },
    google: {
      project_id: overlay.google.project_id || base.google.project_id,
      region: overlay.google.region || base.google.region,
    },
    profiles: { ...base.profiles },
    templates: { ...base.templates },
    services: { ...base.services },
    proxy: {
      ...base.proxy,
      enabled: overlay.proxy.enabled || base.proxy.enabled,
      listen: {
        host: overlay.proxy.listen.host || base.proxy.listen.host,
        port: overlay.proxy.listen.port || base.proxy.listen.port,
      },
      token_endpoint: {
        enabled: overlay.proxy.token_endpoint.enabled || base.proxy.token_endpoint.enabled,
        host: overlay.proxy.token_endpoint.host || base.proxy.token_endpoint.host,
        port: overlay.proxy.token_endpoint.port || base.proxy.token_endpoint.port,
      },
      routes: overlay.proxy.routes.length > 0 ? overlay.proxy.routes : base.proxy.routes,
    },
    logs: overlay.logs.max_memory_events !== base.logs.max_memory_events ? overlay.logs : base.logs,
    environment: {
      sources: overlay.environment.sources.length > 0 ? overlay.environment.sources : base.environment.sources,
      secrets: { ...base.environment.secrets, ...overlay.environment.secrets },
    },
    plugins: overlay.plugins.length > 0 ? overlay.plugins : base.plugins,
  };
  for (const [name, profile] of Object.entries(overlay.profiles)) {
    const existing = out.profiles[name];
    out.profiles[name] = existing ? mergeProfile(existing, profile) : profile;
  }
  for (const [name, svc] of Object.entries(overlay.services)) {
    const existing = out.services[name];
    out.services[name] = existing ? mergeService(existing, svc) : svc;
  }
  for (const [name, tmpl] of Object.entries(overlay.templates)) {
    out.templates[name] = tmpl;
  }
  return out;
}

function mergeProfile(base: ProfileConfig, overlay: ProfileConfig): ProfileConfig {
  return {
    services: overlay.services.length > 0 ? overlay.services : base.services,
    environment: { ...base.environment, ...overlay.environment },
  };
}

export function mergeService(base: ServiceConfig, overlay: ServiceConfig): ServiceConfig {
  const out: ServiceConfig = { ...base, environment: mergeEnv(base.environment, overlay.environment) };
  if (overlay.extends !== "") {
    out.extends = overlay.extends;
  }
  if (overlay.description !== "") {
    out.description = overlay.description;
  }
  if (!commandEmpty(overlay.command)) {
    out.command = overlay.command;
  }
  if (overlay.shell) {
    out.shell = true;
  }
  if (overlay.working_dir !== "") {
    out.working_dir = overlay.working_dir;
  }
  if (overlay.dependencies.length > 0) {
    out.dependencies = overlay.dependencies;
  }
  if (overlay.ports.length > 0) {
    out.ports = overlay.ports;
  }
  if (
    overlay.health.type !== "" ||
    overlay.health.url !== "" ||
    overlay.health.address !== "" ||
    !commandEmpty(overlay.health.command)
  ) {
    out.health = overlay.health;
  }
  if (identityKind(overlay.identity) !== "" || overlay.identity.service_account !== "") {
    out.identity = overlay.identity;
  }
  if (overlay.logs.stdout || overlay.logs.stderr) {
    out.logs = overlay.logs;
  }
  if (overlay.restart.policy !== "" || overlay.restart.enabled !== undefined || overlay.restart.max_retries !== 0) {
    out.restart = overlay.restart;
  }
  if (overlay.startup.wait_for_healthy || overlay.startup.timeout_seconds !== 0) {
    out.startup = overlay.startup;
  }
  if (overlay.capabilities.length > 0) {
    out.capabilities = overlay.capabilities;
  }
  if (overlay.proxy.length > 0) {
    out.proxy = overlay.proxy;
  }
  return out;
}

function mergeEnv(base: EnvConfig, overlay: EnvConfig): EnvConfig {
  return {
    vars: { ...base.vars, ...overlay.vars },
    defaults: { ...base.defaults, ...overlay.defaults },
    required: overlay.required.length > 0 ? overlay.required : [...base.required],
  };
}

export function mergeServiceProxyRoutes(cfg: DevctlConfig): void {
  const names = Object.keys(cfg.services).sort();
  for (const name of names) {
    const fragments = cfg.services[name]?.proxy ?? [];
    if (fragments.length === 0) {
      continue;
    }
    fragments.forEach((frag, i) => {
      const routeName = fragments.length === 1 ? name : `${name}-${i + 1}`;
      cfg.proxy.routes.push({
        name: routeName,
        match: frag.match,
        upstream: frag.upstream,
        auth: frag.auth,
      });
    });
  }
}

export function applyTemplates(cfg: DevctlConfig): void {
  if (Object.keys(cfg.templates).length === 0) {
    return;
  }
  const resolved: Record<string, ServiceConfig> = {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    resolved[name] = applyTemplateChain(cfg, svc, {});
  }
  cfg.services = resolved;
}

function applyTemplateChain(cfg: DevctlConfig, svc: ServiceConfig, seen: Record<string, boolean>): ServiceConfig {
  if (svc.extends === "") {
    return svc;
  }
  if (seen[svc.extends]) {
    throw new Error(`template cycle involving "${svc.extends}"`);
  }
  const tmpl = cfg.templates[svc.extends] ?? emptyService();
  if (!cfg.templates[svc.extends]) {
    throw new Error(`service extends unknown template "${svc.extends}"`);
  }
  const nextSeen = { ...seen, [svc.extends]: true };
  const base = applyTemplateChain(cfg, tmpl, nextSeen);
  const merged = mergeService(base, svc);
  merged.extends = svc.extends;
  return merged;
}
