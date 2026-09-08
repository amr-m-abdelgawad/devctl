import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse } from "yaml";
import { DevctlError, isKind, KindConfiguration, KindConfigurationMissing, newError, wrapError } from "../../shared/errors.ts";
import { homeDir } from "../storage/storage.ts";
import { decodeProfile, decodeRoute, decodeService, isRecord } from "./decode.ts";
import { ConfigDirName, ConfigFileName, discover, fileExists } from "./discover.ts";
import { applyRoot, applyTemplates, mergeService, mergeServiceProxyRoutes, newConfigPresence, recordPresence, recordProvenance, type ConfigPresence } from "./merge.ts";
import { migrate } from "./migrate.ts";
import { collectUnknownFields, formatUnknown } from "./strict.ts";
import { defaultConfig, type DevctlConfig } from "../../domain/config/types.ts";
import { validate } from "./validate.ts";

// Buffer validation (the TUI's config screen `v` / `/buffer`) needs to check
// unsaved edits against the *real* pipeline — modular services/profiles,
// local overlays, templates — not a hand-rolled subset of it that silently
// drifts out of sync. candidateText is the hook: it substitutes the given
// text at the point loadPath() would otherwise read configPath from disk,
// and everything downstream of that runs exactly as it does for a real load.
export function validateConfigText(repoRoot: string, configPath: string, text: string): string[] {
  try {
    loadPath(repoRoot, configPath, { candidateText: text });
    return [];
  } catch (err) {
    // One array entry per distinct problem would be nice, but the underlying
    // errors don't share a shape that supports it uniformly: a validate()
    // failure joins multiple issues with "\n", while a YAML parse error's
    // *single* message also contains embedded newlines (the parser's own
    // source-context snippet) that must not be split apart. The only
    // caller (the TUI config buffer) immediately rejoins with "\n" for
    // display anyway, so keep this as one element and preserve full detail.
    if (err instanceof DevctlError) {
      const prefix = `${err.kind}: `;
      const message = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
      return [message];
    }
    return [err instanceof Error ? err.message : String(err)];
  }
}

export function load(startDir: string, explicit: string): DevctlConfig {
  const { repoRoot, configPath } = discover(startDir, explicit);
  return loadPath(repoRoot, configPath);
}

// load(), except that "there is no configuration yet" yields an empty config
// rooted where one would go, instead of throwing. This is what lets a
// supervisor boot in setup mode so an agent can be pointed at the MCP server
// *before* the repository has a .devctl at all — the bootstrap case that
// `devctl mcp --on` needs and every other command deliberately does not.
//
// Only KindConfigurationMissing is swallowed. A configuration that exists but
// is invalid still throws: silently replacing a broken config with an empty
// one would hide the user's real error and invite an agent to overwrite it.
export function loadOrEmpty(startDir: string, explicit: string): DevctlConfig {
  try {
    return load(startDir, explicit);
  } catch (err) {
    if (!isKind(err, KindConfigurationMissing)) {
      throw err;
    }
    const repoRoot = startDir === "" ? process.cwd() : resolve(startDir);
    const cfg = defaultConfig();
    cfg.repoRoot = repoRoot;
    // The path a config *would* live at. validateConfigText() substitutes
    // candidate text at the main-file read step and never stats this path,
    // so buffer validation works against it before anything is written.
    cfg.configPath = join(repoRoot, ConfigDirName, ConfigFileName);
    return cfg;
  }
}

export function loadPath(repoRoot: string, configPath: string, opts?: { candidateText?: string }): DevctlConfig {
  let cfg = defaultConfig();
  const presence = newConfigPresence();
  decodeFile(configPath, cfg, presence, opts?.candidateText, "main");
  cfg.repoRoot = repoRoot;
  cfg.configPath = configPath;
  const dir = dirname(configPath);
  if (basename(dir) === ConfigDirName) {
    loadModular(dir, cfg, presence);
  }
  cfg = applyLocalOverlays(cfg, repoRoot, configPath, presence);
  cfg = migrate(cfg);
  try {
    applyTemplates(cfg, presence);
  } catch (err) {
    throw wrapError(KindConfiguration, "template merge failed", err);
  }
  mergeServiceProxyRoutes(cfg, presence.provenance);
  cfg.provenance = presence.provenance;
  const issues = validate(cfg);
  if (issues.length > 0) {
    throw newError(KindConfiguration, issues.join("\n"));
  }
  return cfg;
}

function applyLocalOverlays(cfg: DevctlConfig, repoRoot: string, configPath: string, presence: ConfigPresence): DevctlConfig {
  const homeLocal = join(homeDir(), "config.local.yaml");
  const repoLocal = join(repoRoot, ConfigDirName, "config.local.yaml");
  for (const path of [homeLocal, repoLocal]) {
    if (path === configPath || !fileExists(path)) {
      continue;
    }
    // Applied directly onto the accumulating cfg (not a fresh defaultConfig()
    // merged in afterward) so presence-aware field-by-field merging sees what
    // the main file and any modular files have already contributed.
    decodeFile(path, cfg, presence, undefined, path === homeLocal ? "home_local" : "repo_local");
  }
  return cfg;
}

function decodeFile(path: string, cfg: DevctlConfig, presence: ConfigPresence, candidateText?: string, layer = "main"): void {
  const raw = candidateText !== undefined ? parseYamlText(candidateText, path) : parseYamlFile(path);
  const unknown = collectUnknownFields(raw, "");
  if (unknown.length > 0) {
    throw newError(KindConfiguration, formatUnknown(unknown));
  }
  applyRoot(cfg, raw, presence, { source: path, layer });
}

function loadModular(dir: string, cfg: DevctlConfig, presence: ConfigPresence): void {
  loadYAMLDir(join(dir, "services"), (name, node, source) => {
    const unknown = collectUnknownFields(node, `services.${name}`);
    if (unknown.length > 0) {
      throw newError(KindConfiguration, formatUnknown(unknown));
    }
    const existing = cfg.services[name];
    cfg.services[name] = existing ? mergeService(existing, node) : decodeService(node);
    recordPresence(presence.services, name, node);
    recordProvenance(presence.provenance, node, source, "modular_service", `services.${name}`);
  });
  loadYAMLDir(join(dir, "profiles"), (name, node, source) => {
    const unknown = collectUnknownFields(node, `profiles.${name}`);
    if (unknown.length > 0) {
      throw newError(KindConfiguration, formatUnknown(unknown));
    }
    cfg.profiles[name] = decodeProfile(node);
    recordProvenance(presence.provenance, node, source, "modular_profile", `profiles.${name}`);
  });
  const routesPath = join(dir, "proxy", "routes.yaml");
  if (fileExists(routesPath)) {
    applyRoutesFile(routesPath, cfg, presence);
  }
}

function applyRoutesFile(routesPath: string, cfg: DevctlConfig, presence: ConfigPresence): void {
  const wrap = parseYamlFile(routesPath);
  if (isRecord(wrap.proxy)) {
    recordProvenance(presence.provenance, wrap.proxy, routesPath, "modular_proxy", "proxy");
  }
  if (Array.isArray(wrap.routes)) {
    recordProvenance(presence.provenance, wrap.routes, routesPath, "modular_proxy", "proxy.routes");
  }
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

function loadYAMLDir(dir: string, fn: (name: string, node: unknown, source: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (isNotFound(err)) {
      return;
    }
    throw err;
  }
  for (const entry of entries.sort()) {
    const ext = extname(entry);
    if (ext !== ".yaml" && ext !== ".yml") {
      continue;
    }
    const path = join(dir, entry);
    const node = parseYamlFile(path);
    fn(basename(entry, ext), node, path);
  }
}

function parseYamlFile(path: string): Record<string, unknown> {
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch (err) {
    throw wrapError(KindConfiguration, "unable to read config", err);
  }
  return parseYamlText(data, path);
}

function parseYamlText(data: string, path: string): Record<string, unknown> {
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
export * from "../../domain/config/types.ts";
