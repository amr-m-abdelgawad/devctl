import { statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type DevctlConfig,
  type ServiceConfig,
  load,
  unresolvedHealthTypes,
  unresolvedIdentityTypes,
} from "../config/index.ts";
import { ENV_SOURCE_ORDER } from "../environment/environment.ts";
import { configSnapshotDiff, replaceSnapshot } from "../../domain/config/snapshot.ts";
import { emptyRuntime, supervisorRestartAdvice, type Runtime } from "../../domain/service/services.ts";
import type { ReloadResult } from "../../domain/status.ts";
import type { FileSystem } from "../../ports/filesystem.ts";
import type { ServiceOrchestratorPort } from "../../ports/daemon.ts";
import { KindConfiguration, humanMessage, newError } from "../../shared/errors.ts";
import { ConfigurationChanged, ConfigurationReloadFailed, newEvent, type Bus } from "../../shared/events.ts";
import { loadPluginPaths, type Registry } from "../plugins/registry.ts";
import type { Detector } from "../secrets/detector.ts";
import type { TokenManager } from "../google/token.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { ProxyMiddleware } from "../proxy/proxy.ts";

const WATCH_DEBOUNCE_MS = 200;

export type ReloadHost = {
  cfg: DevctlConfig;
  setupMode: boolean;
  configWatcher?: FSWatcher;
  watchTimer?: ReturnType<typeof setTimeout>;
  restartRequired: string[];
  readonly fs: FileSystem;
  registry?: Registry;
  pluginMtimes: Map<string, number>;
  readonly detector: Detector;
  readonly bus: Bus;
  readonly orchestrator: ServiceOrchestratorPort;
  readonly runtimes: Map<string, Runtime>;
  readonly tokens: TokenManager;
  readonly logs: LogStore;
  readonly proxy?: { isRunning(): boolean; setMiddleware?(middleware: ProxyMiddleware[]): void };
  persistState(): void;
  log(service: string, level: string, message: string): void;
  refreshIdentity(): Promise<void>;
  startProxy(): Promise<void>;
  stopProxy(): Promise<void>;
  reload(): Promise<ReloadResult>;
  forgetService(name: string): void;
  syncServiceWatchers(): void;
};

export function applyRegistry(host: ReloadHost): void {
  if (!host.registry) {
    return;
  }
  if (host.registry.tokenProviders.length > 0) {
    host.tokens.replaceProviders(host.registry.tokenProviders);
  }
  host.logs.setParsers(host.registry.logParsers, host.registry.pluginPaths);
  host.proxy?.setMiddleware?.(host.registry.proxyMiddleware);
}

export function pluginMtimes(paths: string[], repoRoot: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const path of paths) {
    const resolved = resolvePluginPath(path, repoRoot);
    try {
      out.set(resolved, statSync(resolved).mtimeMs);
    } catch {
      // Missing files are already reported as plugin load errors.
    }
  }
  return out;
}

export async function reapplyPlugins(host: ReloadHost, next: DevctlConfig, prevPaths: string[]): Promise<string[]> {
  const nextPaths = next.plugins.map((plugin) => plugin.path);
  const listChanged = JSON.stringify(prevPaths) !== JSON.stringify(nextPaths);
  const current = pluginMtimes(nextPaths, next.repoRoot);
  const restart: string[] = [];
  for (const [path, mtime] of current) {
    const previous = host.pluginMtimes.get(path);
    if (previous !== undefined && previous !== mtime) {
      restart.push("plugins");
      break;
    }
  }
  if (listChanged) {
    const registry = await loadPluginPaths(nextPaths, next.repoRoot);
    host.registry = registry;
    for (const failure of registry.loadErrors) {
      host.log("devctl", "ERROR", `plugin ${failure.path} skipped: ${failure.message}`);
    }
    applyRegistry(host);
    host.log("devctl", "INFO", "plugin path list reloaded");
  }
  host.pluginMtimes = current;
  return restart;
}

function resolvePluginPath(path: string, repoRoot: string): string {
  if (path.startsWith("file:")) {
    return path;
  }
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

export function checkPluginHealthTypes(registry: Registry | undefined, cfg: DevctlConfig): void {
  const unresolved = unresolvedHealthTypes(cfg);
  if (unresolved.length === 0) {
    return;
  }
  // checkHealth() matches plugin name to health.type case-insensitively; mirror that here.
  const known = new Set((registry?.healthChecks ?? []).map((check) => check.name.toLowerCase()));
  const stillUnknown = unresolved.filter((entry) => !known.has(entry.type.toLowerCase()));
  if (stillUnknown.length > 0) {
    throw newError(
      KindConfiguration,
      `unknown health check type(s): ${stillUnknown.map((entry) => `${entry.service}.health.type=${entry.type}`).join(", ")}`,
    );
  }
}

export function checkPluginIdentityTypes(registry: Registry | undefined, cfg: DevctlConfig): void {
  const unresolved = unresolvedIdentityTypes(cfg);
  if (unresolved.length === 0) {
    return;
  }
  // The built-in user provider accepts anything that isn't a service
  // account, so only providers loaded from plugin modules count here.
  // Track provenance rather than filtering by name: plugin authors are
  // free to choose names that happen to match a built-in provider.
  const pluginProviders = registry?.pluginIdentityProviders ?? [];
  const stillUnknown = unresolved.filter(({ service }) => {
    const svc = cfg.services[service];
    return !svc || !pluginProviders.some((provider) => provider.accepts(svc.identity));
  });
  if (stillUnknown.length > 0) {
    throw newError(
      KindConfiguration,
      `unknown identity type(s): ${stillUnknown.map((entry) => `${entry.service}.identity.type=${entry.type}`).join(", ")}`,
    );
  }
}

export function checkPluginEnvironmentSources(registry: Registry | undefined, cfg: DevctlConfig): void {
  const builtin = new Set<string>(ENV_SOURCE_ORDER);
  const registered = new Set((registry?.environmentSources ?? []).map((source) => source.name));
  const unknown = cfg.environment.sources.filter((name) => !builtin.has(name) && !registered.has(name));
  if (unknown.length > 0) throw newError(KindConfiguration, `unknown environment source(s): ${unknown.join(", ")}`);
}

export function reconcileServices(
  host: ReloadHost,
  prevServices: Record<string, ServiceConfig>,
  nextServices: Record<string, ServiceConfig>,
): void {
  for (const name of Object.keys(nextServices)) {
    if (!prevServices[name] && !host.runtimes.has(name)) {
      host.runtimes.set(name, emptyRuntime(name));
    }
  }
  for (const name of Object.keys(prevServices)) {
    if (nextServices[name]) {
      continue;
    }
    if (host.orchestrator.serviceIsActive(name)) {
      const rt = host.runtimes.get(name);
      if (rt) {
        rt.orphaned = true;
      }
      host.log(name, "WARN", "removed from configuration while still running; now orphaned — stop it explicitly to clean it up");
      continue;
    }
    host.forgetService(name);
  }
}

export function watchConfig(host: ReloadHost): void {
  const dir = join(host.cfg.repoRoot, ".devctl");
  if (!host.fs.exists(dir)) {
    return;
  }
  try {
    host.configWatcher = watch(dir, { recursive: true }, () => {
      if (host.watchTimer) {
        clearTimeout(host.watchTimer);
      }
      host.watchTimer = setTimeout(() => {
        void host.reload().catch((err) => host.log("devctl", "WARN", humanMessage(err)));
      }, WATCH_DEBOUNCE_MS);
    });
  } catch {
    host.log("devctl", "WARN", "unable to watch .devctl for configuration changes");
  }
}

export async function reloadSupervisor(host: ReloadHost): Promise<ReloadResult> {
  let next: DevctlConfig;
  try {
    next = load(host.cfg.repoRoot, host.cfg.configPath);
  } catch (err) {
    // this.cfg is untouched at this point, so the daemon keeps running on
    // its last-known-good config — but an already-attached client (which
    // didn't necessarily initiate this reload; e.g. the config-file
    // watcher did) has no other way to learn the reload it's about to see
    // reflected in config_snapshot silently failed, so publish it.
    host.bus.publish(newEvent(ConfigurationReloadFailed, "", { error: humanMessage(err) }));
    host.log("devctl", "ERROR", `configuration reload failed: ${humanMessage(err)}`);
    throw err;
  }
  try {
    // Revalidate against the candidate config, not this.cfg — a newly
    // added service (or one whose health/identity type just changed)
    // referencing a plugin type nothing provides should reject the
    // reload the same way an unparseable config file does, rather than
    // silently taking effect and only surfacing once someone starts it.
    checkPluginHealthTypes(host.registry, next);
    checkPluginIdentityTypes(host.registry, next);
    checkPluginEnvironmentSources(host.registry, next);
  } catch (err) {
    host.bus.publish(newEvent(ConfigurationReloadFailed, "", { error: humanMessage(err) }));
    host.log("devctl", "ERROR", `configuration reload failed: ${humanMessage(err)}`);
    throw err;
  }
  if (host.setupMode) {
    host.setupMode = false;
    host.log("devctl", "INFO", `configuration created at ${host.cfg.configPath}; leaving setup mode`);
    // watchConfig() returned early at boot because .devctl did not exist
    // yet. Now that it does, start watching it — otherwise a repository
    // onboarded through setup mode would silently never pick up later
    // edits, unlike every other repository.
    if (!host.configWatcher) {
      watchConfig(host);
    }
  }
  const result = configSnapshotDiff(host.cfg, next);
  const proxyChanged = JSON.stringify(host.cfg.proxy) !== JSON.stringify(next.proxy);
  const secretsChanged = JSON.stringify(host.cfg.secrets) !== JSON.stringify(next.secrets);
  const prevPluginPaths = host.cfg.plugins.map((plugin) => plugin.path);
  const prevServices = host.cfg.services;
  host.cfg = replaceSnapshot(host.cfg, next);
  reconcileServices(host, prevServices, next.services);
  const restartRequired = mergeRestartRequired(host.restartRequired, result.restart_required, Object.keys(next.services));
  host.restartRequired = restartRequired;
  result.restart_required = restartRequired;
  // Detector is a cheap, stateless holder of markers/patterns — update it
  // in place so the LogManager/ProxyServer instances that already hold a
  // reference to it see the new rules immediately. LogManager is
  // deliberately NOT rebuilt here: recreating it would drop the in-memory
  // log ring buffer and start a new persistence session out from under
  // the TUI. Plugin *path list* changes hot-apply; same-path mtime still
  // advises a supervisor restart (Bun module cache).
  const pluginRestart = await reapplyPlugins(host, next, prevPluginPaths);
  if (pluginRestart.length > 0) {
    result.supervisor_restart_required = [...(result.supervisor_restart_required ?? []), ...pluginRestart];
  }
  host.syncServiceWatchers();
  if (secretsChanged) {
    host.detector.update(next.secrets.extra_markers, next.secrets.extra_patterns);
    host.logs.setSecrets(next.secrets.extra_markers, next.secrets.extra_patterns);
  }
  if (proxyChanged) {
    const wasRunning = host.proxy?.isRunning() ?? false;
    await host.stopProxy();
    if (wasRunning && host.cfg.proxy.enabled) {
      await host.startProxy();
    }
    host.log("devctl", "INFO", "proxy configuration changed; proxy restarted");
  }
  host.bus.publish(
    newEvent(ConfigurationChanged, "", {
      restart_required: result.restart_required,
      changes: result.changes,
      supervisor_restart_required: result.supervisor_restart_required,
    }),
  );
  host.log("devctl", "INFO", result.restart_required.length === 0 ? "configuration reloaded" : `configuration reloaded; restart required: ${result.restart_required.join(", ")}`);
  if (result.supervisor_restart_required) {
    host.log("devctl", "WARN", supervisorRestartAdvice(result.supervisor_restart_required));
  }
  host.persistState();
  void host.refreshIdentity();
  return result;
}

export function mergeRestartRequired(previous: string[], incoming: string[], stillInConfig: string[]): string[] {
  const still = new Set(stillInConfig);
  const pending = new Set(previous.filter((name) => still.has(name)));
  for (const name of incoming) {
    if (still.has(name)) {
      pending.add(name);
    }
  }
  return [...pending].sort();
}
