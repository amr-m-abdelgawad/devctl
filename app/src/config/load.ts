import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parse } from "yaml";
import { KindConfiguration, newError, wrapError } from "../errors.ts";
import { homeDir } from "../storage.ts";
import { applyRoot, decodeProfile, decodeRoute, decodeService, isRecord } from "./decode.ts";
import { ConfigDirName, discover, fileExists } from "./discover.ts";
import { applyTemplates, mergeConfig, mergeService, mergeServiceProxyRoutes } from "./merge.ts";
import { migrate } from "./migrate.ts";
import { collectUnknownFields, formatUnknown } from "./strict.ts";
import { defaultConfig, type DevctlConfig } from "./types.ts";
import { validate } from "./validate.ts";

export function validateConfigText(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (err) {
    return [`invalid YAML: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (!isRecord(parsed)) {
    return ["config is not a mapping"];
  }
  const unknown = collectUnknownFields(parsed, "");
  if (unknown.length > 0) {
    return [formatUnknown(unknown)];
  }
  const cfg = defaultConfig();
  applyRoot(cfg, parsed);
  try {
    applyTemplates(cfg);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  mergeServiceProxyRoutes(cfg);
  return validate(cfg);
}

export function load(startDir: string, explicit: string): DevctlConfig {
  const { repoRoot, configPath } = discover(startDir, explicit);
  return loadPath(repoRoot, configPath);
}

export function loadPath(repoRoot: string, configPath: string): DevctlConfig {
  let cfg = defaultConfig();
  decodeFile(configPath, cfg);
  cfg.repoRoot = repoRoot;
  cfg.configPath = configPath;
  const dir = dirname(configPath);
  if (basename(dir) === ConfigDirName) {
    loadModular(dir, cfg);
  }
  cfg = applyLocalOverlays(cfg, repoRoot, configPath);
  cfg = migrate(cfg);
  try {
    applyTemplates(cfg);
  } catch (err) {
    throw wrapError(KindConfiguration, "template merge failed", err);
  }
  mergeServiceProxyRoutes(cfg);
  const issues = validate(cfg);
  if (issues.length > 0) {
    throw newError(KindConfiguration, issues.join("\n"));
  }
  return cfg;
}

function applyLocalOverlays(cfg: DevctlConfig, repoRoot: string, configPath: string): DevctlConfig {
  let next = cfg;
  const homeLocal = join(homeDir(), "config.local.yaml");
  const repoLocal = join(repoRoot, ConfigDirName, "config.local.yaml");
  for (const path of [homeLocal, repoLocal]) {
    if (path === configPath || !fileExists(path)) {
      continue;
    }
    const overlay = defaultConfig();
    decodeFile(path, overlay);
    next = mergeConfig(next, overlay);
  }
  return next;
}

function decodeFile(path: string, cfg: DevctlConfig): void {
  const raw = parseYamlFile(path);
  const unknown = collectUnknownFields(raw, "");
  if (unknown.length > 0) {
    throw newError(KindConfiguration, formatUnknown(unknown));
  }
  applyRoot(cfg, raw);
}

function loadModular(dir: string, cfg: DevctlConfig): void {
  loadYAMLDir(join(dir, "services"), (name, node) => {
    const unknown = collectUnknownFields(node, `services.${name}`);
    if (unknown.length > 0) {
      throw newError(KindConfiguration, formatUnknown(unknown));
    }
    const svc = decodeService(node);
    const existing = cfg.services[name];
    cfg.services[name] = existing ? mergeService(existing, svc) : svc;
  });
  loadYAMLDir(join(dir, "profiles"), (name, node) => {
    const unknown = collectUnknownFields(node, `profiles.${name}`);
    if (unknown.length > 0) {
      throw newError(KindConfiguration, formatUnknown(unknown));
    }
    cfg.profiles[name] = decodeProfile(node);
  });
  const routesPath = join(dir, "proxy", "routes.yaml");
  if (fileExists(routesPath)) {
    applyRoutesFile(routesPath, cfg);
  }
}

function applyRoutesFile(routesPath: string, cfg: DevctlConfig): void {
  const wrap = parseYamlFile(routesPath);
  if (isRecord(wrap.proxy)) {
    const unknown = collectUnknownFields({ proxy: wrap.proxy }, "");
    if (unknown.length > 0) {
      throw newError(KindConfiguration, formatUnknown(unknown));
    }
  }
  if (Array.isArray(wrap.routes)) {
    wrap.routes.forEach((route, i) => {
      const unknown = collectUnknownFields(route, `proxy.routes.${i}`);
      if (unknown.length > 0) {
        throw newError(KindConfiguration, formatUnknown(unknown));
      }
    });
  }
  if (isRecord(wrap.proxy)) {
    if (Array.isArray(wrap.proxy.routes)) {
      cfg.proxy.routes.push(...wrap.proxy.routes.map((route) => decodeRoute(route)));
    }
    if (isRecord(wrap.proxy.listen)) {
      if (typeof wrap.proxy.listen.host === "string" && wrap.proxy.listen.host !== "") {
        cfg.proxy.listen.host = wrap.proxy.listen.host;
      }
      if (typeof wrap.proxy.listen.port === "number" && wrap.proxy.listen.port !== 0) {
        cfg.proxy.listen.port = wrap.proxy.listen.port;
      }
    }
  }
  if (Array.isArray(wrap.routes)) {
    cfg.proxy.routes.push(...wrap.routes.map((route) => decodeRoute(route)));
  }
}

function loadYAMLDir(dir: string, fn: (name: string, node: unknown) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (isNotFound(err)) {
      return;
    }
    throw err;
  }
  for (const entry of entries) {
    const ext = extname(entry);
    if (ext !== ".yaml" && ext !== ".yml") {
      continue;
    }
    const path = join(dir, entry);
    const node = parseYamlFile(path);
    fn(basename(entry, ext), node);
  }
}

function parseYamlFile(path: string): Record<string, unknown> {
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch (err) {
    throw wrapError(KindConfiguration, "unable to read config", err);
  }
  let parsed: unknown;
  try {
    parsed = parse(data);
  } catch (err) {
    throw wrapError(KindConfiguration, `invalid YAML in ${path}`, err);
  }
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isRecord(parsed)) {
    throw newError(KindConfiguration, `unable to decode config: ${path} is not a mapping`);
  }
  return parsed;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "ENOENT";
}

export { discover } from "./discover.ts";
export { validate } from "./validate.ts";
export * from "./types.ts";
