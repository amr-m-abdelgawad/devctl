import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseAllDocuments } from "yaml";
import type { DevctlConfig, HelmEnvConfig } from "../../domain/config/types.ts";
import { KindConfiguration, newError } from "../../shared/errors.ts";

// Literal environment values from a Helm chart or Kubernetes YAML.
// Go template actions are skipped. valueFrom secrets are skipped.

const ENV_FIELD_NAMES = ["env", "extraEnv", "extraEnvs", "envVars", "environment"];
const HELM_SKIP = "HELM_SKIP";
const HELM_ACTION = /\{\{[\s\S]*?\}\}/g;
const HELM_ACTION_ONE = /\{\{[\s\S]*?\}\}/;
const RESOURCE_ADDRESS = /^[A-Za-z][A-Za-z0-9]*(\/[^/\s]+)?$/;

type HelmFile = { name: string; abs: string; values: boolean };
type HelmRead = { issues: string[]; values: Record<string, string> };
type LocatedHelm = { files: HelmFile[] } | { error: string };
type ExtractState = { foundResource: boolean; values: Record<string, string> };

export function helmConfigIssues(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  for (const [name, svc] of Object.entries(cfg.services)) {
    issues.push(...inspectHelm(`services.${name}.environment.helm`, cfg.repoRoot, svc.environment.helm).issues);
    for (const [envName, env] of Object.entries(svc.environments)) {
      issues.push(...inspectHelm(`services.${name}.environments.${envName}.helm`, cfg.repoRoot, env.helm).issues);
    }
  }
  for (const [name, task] of Object.entries(cfg.tasks)) {
    issues.push(...inspectHelm(`tasks.${name}.environment.helm`, cfg.repoRoot, task.environment.helm).issues);
  }
  for (const [profile, body] of Object.entries(cfg.profiles)) {
    for (const [service, env] of Object.entries(body.service_environment)) {
      issues.push(...inspectHelm(`profiles.${profile}.service_environment.${service}.helm`, cfg.repoRoot, env.helm).issues);
    }
  }
  return issues;
}

export function loadHelmEnvironment(repoRoot: string, prefix: string, spec: HelmEnvConfig | undefined): Record<string, string> {
  if (!spec || spec.path === "") return {};
  const read = inspectHelm(prefix, repoRoot, spec);
  if (read.issues.length > 0) {
    throw newError(KindConfiguration, read.issues[0] ?? "helm environment failed");
  }
  return read.values;
}

export function extractHelmEnv(
  files: { name: string; text: string; values?: boolean }[],
  resource: string,
): { values: Record<string, string>; foundResource: boolean } {
  const state: ExtractState = { foundResource: false, values: {} };
  for (const file of files) {
    const parsed = parseHelmYaml(file.name, file.text);
    if (parsed.error) throw new Error(parsed.error);
    for (const doc of parsed.docs) {
      walkHelm(doc, file.values === true || resource === "", resource, state);
    }
  }
  return { values: state.values, foundResource: state.foundResource };
}

function inspectHelm(prefix: string, repoRoot: string, spec: HelmEnvConfig | undefined): HelmRead {
  if (!spec) return { issues: [], values: {} };
  const shape = helmShapeIssue(prefix, spec);
  if (shape) return { issues: [shape], values: {} };
  const located = locateHelm(repoRoot, spec.path);
  if ("error" in located) return { issues: [`${prefix}.path ${located.error}`], values: {} };
  const state: ExtractState = { foundResource: false, values: {} };
  let firstError = "";
  for (const file of located.files) {
    const loaded = readHelmText(prefix, file);
    if (loaded.error) {
      if (firstError === "") firstError = loaded.error;
    } else if (loaded.text !== "") {
      const parsed = parseHelmYaml(file.name, loaded.text);
      if (parsed.error) {
        if (firstError === "") firstError = `${prefix}: ${parsed.error}`;
      } else {
        for (const doc of parsed.docs) walkHelm(doc, file.values || spec.resource === "", spec.resource, state);
      }
    }
  }
  return helmExtractionIssues(prefix, spec, state, firstError);
}

function readHelmText(prefix: string, file: HelmFile): { text: string; error?: string } {
  try {
    return { text: readFileSync(file.abs, "utf8") };
  } catch {
    return { text: "", error: `${prefix}: could not read ${file.name}` };
  }
}

function helmShapeIssue(prefix: string, spec: HelmEnvConfig): string | undefined {
  if (spec.invalid) return `${prefix} must be a path or an object with path`;
  if (spec.path === "") return `${prefix}.path is required`;
  if (spec.resource !== "" && !RESOURCE_ADDRESS.test(spec.resource)) {
    return `${prefix}.resource must look like Kind or Kind/name`;
  }
  return undefined;
}

function helmExtractionIssues(prefix: string, spec: HelmEnvConfig, state: ExtractState, firstError: string): HelmRead {
  if (spec.resource !== "" && !state.foundResource) {
    return { issues: [`${prefix}.resource "${spec.resource}" was not found in ${spec.path}`], values: {} };
  }
  if (Object.keys(state.values).length === 0) {
    const detail = firstError !== "" ? firstError : `${prefix}: no literal env values in ${spec.path} (Helm templates and valueFrom are skipped)`;
    return { issues: [detail], values: {} };
  }
  return { issues: [], values: state.values };
}

function locateHelm(repoRoot: string, path: string): LocatedHelm {
  const trimmed = path.trim();
  const root = resolve(repoRoot);
  const abs = resolve(root, trimmed);
  if (!pathStaysInRepo(root, abs)) return { error: "must stay inside the repository" };
  if (!existsSync(abs)) return { error: `not found: ${trimmed}` };
  let realRoot = root;
  let real = abs;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(abs);
  } catch {
    return { error: `not found: ${trimmed}` };
  }
  if (!pathStaysInRepo(realRoot, real)) return { error: "must stay inside the repository" };
  const stat = statSync(real);
  if (stat.isDirectory()) return locateHelmDir(real, realRoot, trimmed);
  if (stat.isFile() && isYamlName(real)) return { files: [{ name: trimmed, abs: real, values: isValuesPath(trimmed) }] };
  return { error: "must be a .yaml or .yml file, or a directory" };
}

function locateHelmDir(dir: string, root: string, display: string): LocatedHelm {
  if (isChartDir(dir)) return locateChart(dir, root, display);
  const files: HelmFile[] = [];
  const err = yamlFilesUnder(dir, root, false, files, false);
  if (err) return { error: err };
  if (files.length === 0) return { error: `has no YAML files: ${display}` };
  return { files };
}

function locateChart(dir: string, root: string, display: string): LocatedHelm {
  const files: HelmFile[] = [];
  for (const name of ["values.yaml", "values.yml"]) {
    const err = pushIfExists(join(dir, name), root, true, files);
    if (err) return { error: err };
  }
  const valuesDir = join(dir, "values");
  if (existsSync(valuesDir) && statSync(valuesDir).isDirectory()) {
    const err = yamlFilesUnder(valuesDir, root, true, files, true);
    if (err) return { error: err };
  }
  const templates = join(dir, "templates");
  if (existsSync(templates) && statSync(templates).isDirectory()) {
    const err = yamlFilesUnder(templates, root, false, files, true);
    if (err) return { error: err };
  }
  if (files.length === 0) return { error: `has no Helm YAML: ${display}` };
  return { files };
}

function isChartDir(dir: string): boolean {
  return existsSync(join(dir, "Chart.yaml")) || existsSync(join(dir, "Chart.yml")) || existsSync(join(dir, "templates")) || existsSync(join(dir, "values.yaml")) || existsSync(join(dir, "values.yml"));
}

function yamlFilesUnder(dir: string, root: string, values: boolean, out: HelmFile[], recurse: boolean): string | undefined {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "charts")
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const err = entry.isDirectory() && recurse
      ? yamlFilesUnder(abs, root, values, out, true)
      : entry.isFile() && isYamlName(entry.name)
        ? pushFile(abs, root, values, out)
        : undefined;
    if (err) return err;
  }
  return undefined;
}

function pushIfExists(abs: string, root: string, values: boolean, out: HelmFile[]): string | undefined {
  if (!existsSync(abs)) return undefined;
  return pushFile(abs, root, values, out);
}

function pushFile(abs: string, root: string, values: boolean, out: HelmFile[]): string | undefined {
  const real = realpathSync(abs);
  if (!pathStaysInRepo(root, real)) return "must stay inside the repository";
  out.push({ name: relative(root, real), abs: real, values });
  return undefined;
}

function isYamlName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

function isValuesPath(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith("/values.yaml") || lower.endsWith("/values.yml") || lower === "values.yaml" || lower === "values.yml" || lower.includes("/values/");
}

function pathStaysInRepo(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function parseHelmYaml(file: string, text: string): { docs: unknown[]; error?: string } {
  try {
    const docs = parseAllDocuments(stripHelm(text));
    const failure = docs.flatMap((doc) => doc.errors)[0];
    if (failure) return { docs: [], error: `${file}: ${failure.message}` };
    return { docs: docs.map((doc) => doc.toJS({ maxAliasCount: 50 })) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid YAML";
    return { docs: [], error: `${file}: ${detail}` };
  }
}

function stripHelm(text: string): string {
  return text.replace(HELM_ACTION, (action, offset) => {
    const lineStart = text.lastIndexOf("\n", offset) + 1;
    const lineEnd = text.indexOf("\n", offset + action.length);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    return line.replace(HELM_ACTION_ONE, "").trim() === "" ? "" : HELM_SKIP;
  });
}

function walkHelm(node: unknown, active: boolean, resource: string, state: ExtractState): void {
  if (Array.isArray(node)) {
    for (const item of node) walkHelm(item, active, resource, state);
    return;
  }
  if (!isRecord(node)) return;
  const here = scopeActive(node, active, resource, state);
  for (const [key, value] of Object.entries(node)) {
    if (here && ENV_FIELD_NAMES.includes(key)) takeEnvField(value, state.values);
    walkHelm(value, here, resource, state);
  }
}

function scopeActive(node: Record<string, unknown>, active: boolean, resource: string, state: ExtractState): boolean {
  if (resource === "") return true;
  const kind = typeof node.kind === "string" ? node.kind : "";
  if (kind === "") return active;
  const name = isRecord(node.metadata) && typeof node.metadata.name === "string" ? node.metadata.name : "";
  const matched = resourceMatches(kind, name, resource);
  if (matched) state.foundResource = true;
  return matched;
}

function resourceMatches(kind: string, name: string, resource: string): boolean {
  const slash = resource.indexOf("/");
  const wantKind = slash < 0 ? resource : resource.slice(0, slash);
  const wantName = slash < 0 ? "" : resource.slice(slash + 1);
  if (kind.toLowerCase() !== wantKind.toLowerCase()) return false;
  return wantName === "" || name === wantName;
}

function takeEnvField(value: unknown, out: Record<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) takeEnvItem(item, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const literal = literalText(item);
    if (key !== "" && literal !== undefined) out[key] = literal;
  }
}

function takeEnvItem(item: unknown, out: Record<string, string>): void {
  if (!isRecord(item) || "valueFrom" in item) return;
  const name = literalText(item.name);
  const value = literalText(item.value);
  if (name && value !== undefined) out[name] = value;
}

function literalText(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (value.includes(HELM_SKIP) || value.includes("{{")) return undefined;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
