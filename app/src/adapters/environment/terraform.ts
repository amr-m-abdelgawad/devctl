import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DevctlConfig, TerraformEnvConfig } from "../../domain/config/types.ts";
import { KindConfiguration, newError } from "../../shared/errors.ts";

// Literal environment values from a service's Terraform. Interpolations,
// secret value_source blocks, and state are left unread. terraform.tfvars,
// *.auto.tfvars, and a path that is itself a .tfvars file supply variable
// values. Other *.tfvars files are not read.

const TERRAFORM_ENV_ATTRIBUTES = ["environment_variables", "env_vars", "env"];
const UNICODE_ESCAPE_DIGITS = 4;
const UTF8_BOM = 0xfeff;
const RESOURCE_ADDRESS = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)+$/;
const ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOLLAR_PLACEHOLDER = "\uE000";
const PERCENT_PLACEHOLDER = "\uE001";

type Token =
  | { t: "id" | "str" | "num"; v: string; line: number; interp?: boolean }
  | { t: "heredoc"; v: string; line: number; interp: boolean }
  | { t: "nl"; line: number }
  | { t: "punct"; v: string; line: number };

type HclValue =
  | { kind: "literal"; value: string }
  | { kind: "object"; entries: { key: string; value: HclValue }[] }
  | { kind: "list"; items: HclValue[] }
  | { kind: "var"; name: string }
  | { kind: "skip" };

type HclItem =
  | { kind: "attr"; key: string; value: HclValue }
  | { kind: "block"; block: HclBlock };

type HclBlock = { type: string; labels: string[]; items: HclItem[] };

type Src = { file: string; src: string; i: number; line: number };
type Cursor = { file: string; tokens: Token[]; i: number };

type ExtractState = { foundResource: boolean; values: Record<string, string> };
type TerraformRead = { issues: string[]; values: Record<string, string> };
type LocatedFile = { name: string; abs: string };
type LocatedTf = { config: LocatedFile[]; tfvars: LocatedFile[] } | { error: string };
type VarMap = ReadonlyMap<string, HclValue>;

export function terraformConfigIssues(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  for (const [name, svc] of Object.entries(cfg.services)) {
    issues.push(...inspectTerraform(`services.${name}.environment.terraform`, cfg.repoRoot, svc.environment.terraform).issues);
    for (const [envName, env] of Object.entries(svc.environments)) {
      issues.push(...inspectTerraform(`services.${name}.environments.${envName}.terraform`, cfg.repoRoot, env.terraform).issues);
    }
  }
  for (const [name, task] of Object.entries(cfg.tasks)) {
    issues.push(...inspectTerraform(`tasks.${name}.environment.terraform`, cfg.repoRoot, task.environment.terraform).issues);
  }
  for (const [profile, body] of Object.entries(cfg.profiles)) {
    for (const [service, env] of Object.entries(body.service_environment)) {
      issues.push(...inspectTerraform(`profiles.${profile}.service_environment.${service}.terraform`, cfg.repoRoot, env.terraform).issues);
    }
  }
  return issues;
}

export function loadTerraformEnvironment(repoRoot: string, prefix: string, spec: TerraformEnvConfig | undefined): Record<string, string> {
  if (!spec || spec.path === "") return {};
  const read = inspectTerraform(prefix, repoRoot, spec);
  if (read.issues.length > 0) {
    throw newError(KindConfiguration, read.issues[0] ?? "terraform environment failed");
  }
  return read.values;
}

export function extractTerraformEnv(
  files: { name: string; text: string }[],
  resource: string,
  attribute: string,
  tfvars: { name: string; text: string }[] = [],
): { values: Record<string, string>; foundResource: boolean } {
  const state: ExtractState = { foundResource: false, values: {} };
  const names = attributeNames(attribute);
  const vars = variableBindings(files, tfvars);
  if (resource === "") applyModuleVars(vars, names, state.values);
  for (const file of files) {
    collect(parseHcl(file.name, file.text).items, resource === "", names, resource, state, vars);
  }
  return { values: state.values, foundResource: state.foundResource };
}

function inspectTerraform(prefix: string, repoRoot: string, spec: TerraformEnvConfig | undefined): TerraformRead {
  if (!spec) return { issues: [], values: {} };
  const shape = terraformShapeIssue(prefix, spec);
  if (shape) return { issues: [shape], values: {} };
  const located = locateTerraform(repoRoot, spec.path);
  if ("error" in located) return { issues: [`${prefix}.path ${located.error}`], values: {} };
  try {
    const extracted = extractTerraformEnv(
      located.config.map((file) => ({ name: file.name, text: readFileSync(file.abs, "utf8") })),
      spec.resource,
      spec.attribute,
      located.tfvars.map((file) => ({ name: file.name, text: readFileSync(file.abs, "utf8") })),
    );
    return extractionIssues(prefix, spec, extracted);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "could not read Terraform";
    return { issues: [`${prefix}: ${detail}`], values: {} };
  }
}

function terraformShapeIssue(prefix: string, spec: TerraformEnvConfig): string | undefined {
  if (spec.invalid) return `${prefix} must be a path or an object with path`;
  if (spec.path === "") return `${prefix}.path is required`;
  if (spec.resource !== "" && !RESOURCE_ADDRESS.test(spec.resource)) {
    return `${prefix}.resource must look like type.name or module.name`;
  }
  if (spec.attribute !== "" && !ATTRIBUTE_NAME.test(spec.attribute)) {
    return `${prefix}.attribute must be a Terraform identifier`;
  }
  return undefined;
}

function extractionIssues(
  prefix: string,
  spec: TerraformEnvConfig,
  extracted: { values: Record<string, string>; foundResource: boolean },
): TerraformRead {
  if (spec.resource !== "" && !extracted.foundResource) {
    return { issues: [`${prefix}.resource "${spec.resource}" was not found in ${spec.path}`], values: {} };
  }
  if (Object.keys(extracted.values).length === 0) {
    return { issues: [`${prefix}: no literal env values in ${spec.path} (interpolations and secret refs are skipped)`], values: {} };
  }
  return { issues: [], values: extracted.values };
}

function locateTerraform(repoRoot: string, path: string): LocatedTf {
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
  if (stat.isDirectory()) return locateTerraformDir(real, realRoot, trimmed);
  if (stat.isFile() && real.endsWith(".tf")) {
    return withAutoTfvars([{ name: trimmed, abs: real }], dirname(real), realRoot);
  }
  if (stat.isFile() && real.endsWith(".tfvars")) return locateTfvarsFile(real, realRoot, trimmed);
  return { error: "must be a .tf file, a .tfvars file, or a directory" };
}

function locateTerraformDir(dir: string, root: string, display: string): LocatedTf {
  const config = filesIn(dir, root, (name) => name.endsWith(".tf"));
  if ("error" in config) return config;
  const located = withAutoTfvars(config, dir, root);
  if ("error" in located) return located;
  if (located.config.length === 0 && located.tfvars.length === 0) return { error: `has no .tf files: ${display}` };
  return located;
}

function locateTfvarsFile(file: string, root: string, display: string): LocatedTf {
  const config = filesIn(dirname(file), root, (name) => name.endsWith(".tf"));
  if ("error" in config) return config;
  return withAutoTfvars(config, dirname(file), root, { name: display, abs: file });
}

function withAutoTfvars(config: LocatedFile[], dir: string, root: string, extra?: LocatedFile): LocatedTf {
  const auto = autoTfvarsIn(dir, root);
  if ("error" in auto) return auto;
  const tfvars = extra ? dedupeFiles([...auto, extra]) : auto;
  return { config, tfvars };
}

function autoTfvarsIn(dir: string, root: string): LocatedFile[] | { error: string } {
  const listed = filesIn(dir, root, isAutoTfvars);
  if ("error" in listed) return listed;
  const terraformTfvars = listed.filter((file) => fileBase(file.name) === "terraform.tfvars");
  const auto = listed
    .filter((file) => fileBase(file.name).endsWith(".auto.tfvars"))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...terraformTfvars, ...auto];
}

function fileBase(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return slash < 0 ? name : name.slice(slash + 1);
}

function isAutoTfvars(name: string): boolean {
  return name === "terraform.tfvars" || name.endsWith(".auto.tfvars");
}

function filesIn(dir: string, root: string, include: (name: string) => boolean): LocatedFile[] | { error: string } {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && include(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const files: LocatedFile[] = [];
  for (const name of names) {
    const abs = realpathSync(join(dir, name));
    if (!pathStaysInRepo(root, abs)) return { error: "must stay inside the repository" };
    files.push({ name: relative(root, abs), abs });
  }
  return files;
}

function dedupeFiles(files: LocatedFile[]): LocatedFile[] {
  const index = new Map<string, number>();
  const out: LocatedFile[] = [];
  for (const file of files) {
    const prev = index.get(file.abs);
    if (prev === undefined) {
      index.set(file.abs, out.length);
      out.push(file);
    } else {
      out[prev] = file;
    }
  }
  return out;
}

function pathStaysInRepo(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function variableBindings(
  files: { name: string; text: string }[],
  tfvars: { name: string; text: string }[],
): Map<string, HclValue> {
  const vars = new Map<string, HclValue>();
  for (const file of files) {
    for (const item of parseHcl(file.name, file.text).items) {
      const name = item.kind === "block" && item.block.type === "variable" ? item.block.labels[0] : undefined;
      const fallback = name !== undefined && item.kind === "block" ? lastAttribute(item.block, "default") : undefined;
      if (name !== undefined && fallback) vars.set(name, fallback);
    }
  }
  for (const file of tfvars) {
    for (const item of parseHcl(file.name, file.text).items) {
      if (item.kind === "attr") vars.set(item.key, item.value);
    }
  }
  return vars;
}

function applyModuleVars(vars: VarMap, names: ReadonlySet<string>, out: Record<string, string>): void {
  for (const name of names) {
    const value = vars.get(name);
    if (value) takeValue(value, out, vars);
  }
}

function resolveBinding(value: HclValue, vars: VarMap): HclValue | undefined {
  if (value.kind !== "var") return value;
  const bound = vars.get(value.name);
  if (!bound || bound.kind === "var" || bound.kind === "skip") return undefined;
  return bound;
}

function attributeNames(extra: string): Set<string> {
  const names = new Set<string>(TERRAFORM_ENV_ATTRIBUTES);
  if (extra !== "") names.add(extra);
  return names;
}

function parseHcl(file: string, text: string): HclBlock {
  const src = text.charCodeAt(0) === UTF8_BOM ? text.slice(1) : text;
  return { type: "", labels: [], items: parseItems({ file, tokens: tokenize(file, src), i: 0 }, "eof") };
}

function collect(items: HclItem[], active: boolean, names: ReadonlySet<string>, resource: string, state: ExtractState, vars: VarMap): void {
  for (const item of items) {
    if (item.kind === "attr") {
      if (active && names.has(item.key)) takeValue(item.value, state.values, vars);
    } else {
      takeBlock(item.block, active, names, resource, state, vars);
    }
  }
}

function takeBlock(block: HclBlock, active: boolean, names: ReadonlySet<string>, resource: string, state: ExtractState, vars: VarMap): void {
  const address = blockAddress(block);
  const matched = resource !== "" && address === resource;
  if (matched) state.foundResource = true;
  const childActive = resource === "" || active || matched;
  if (childActive && block.type === "env" && block.labels.length === 0) takeEnvBlock(block, state.values, vars);
  if (childActive && block.type === "variable") takeVariableDefault(block, names, state.values, vars);
  collect(block.items, childActive, names, resource, state, vars);
}

function blockAddress(block: HclBlock): string {
  const first = block.labels[0];
  const second = block.labels[1];
  if (block.type === "resource" && first !== undefined && second !== undefined) return `${first}.${second}`;
  if (block.type === "module" && first !== undefined) return `module.${first}`;
  if (block.type === "data" && first !== undefined && second !== undefined) return `data.${first}.${second}`;
  return "";
}

function takeEnvBlock(block: HclBlock, out: Record<string, string>, vars: VarMap): void {
  if (blockContains(block, "value_source")) return;
  const name = lastLiteral(block, "name", vars);
  const value = lastLiteral(block, "value", vars);
  if (name === undefined || value === undefined || name === "") return;
  out[name] = value;
}

function takeVariableDefault(block: HclBlock, names: ReadonlySet<string>, out: Record<string, string>, vars: VarMap): void {
  const label = block.labels[0];
  if (label === undefined || !names.has(label)) return;
  const bound = vars.get(label) ?? lastAttribute(block, "default");
  if (bound) takeValue(bound, out, vars);
}

function takeValue(value: HclValue, out: Record<string, string>, vars: VarMap): void {
  const resolved = resolveBinding(value, vars);
  if (!resolved || resolved.kind === "skip" || resolved.kind === "var") return;
  if (resolved.kind === "object") {
    for (const entry of resolved.entries) {
      const item = resolveBinding(entry.value, vars);
      if (item?.kind === "literal" && entry.key !== "") out[entry.key] = item.value;
    }
    return;
  }
  if (resolved.kind === "list") {
    for (const item of resolved.items) takeNameValueItem(item, out, vars);
  }
}

function takeNameValueItem(value: HclValue, out: Record<string, string>, vars: VarMap): void {
  const resolved = resolveBinding(value, vars);
  if (!resolved || resolved.kind !== "object") return;
  let name = "";
  let literal = "";
  let sawName = false;
  let sawValue = false;
  let secret = false;
  for (const entry of resolved.entries) {
    const item = resolveBinding(entry.value, vars);
    if (entry.key === "name" && item?.kind === "literal") {
      name = item.value;
      sawName = true;
    } else if (entry.key === "value" && item?.kind === "literal") {
      literal = item.value;
      sawValue = true;
    } else if (entry.key === "value_source") {
      secret = true;
    }
  }
  if (sawName && sawValue && !secret && name !== "") out[name] = literal;
}

function blockContains(block: HclBlock, type: string): boolean {
  for (const item of block.items) {
    if (item.kind === "block" && (item.block.type === type || blockContains(item.block, type))) return true;
  }
  return false;
}

function lastLiteral(block: HclBlock, key: string, vars: VarMap): string | undefined {
  const value = lastAttribute(block, key);
  if (!value) return undefined;
  const resolved = resolveBinding(value, vars);
  if (!resolved || resolved.kind !== "literal") return undefined;
  return resolved.value;
}

function lastAttribute(block: HclBlock, key: string): HclValue | undefined {
  let found: HclValue | undefined;
  for (const item of block.items) {
    if (item.kind === "attr" && item.key === key) found = item.value;
  }
  return found;
}

function tokenize(file: string, text: string): Token[] {
  const src: Src = { file, src: text, i: 0, line: 1 };
  const tokens: Token[] = [];
  while (src.i < src.src.length) {
    const ch = src.src[src.i] ?? "";
    if (ch === " " || ch === "\t") src.i += 1;
    else if (ch === "\n") pushNewline(src, tokens);
    else if (ch === "\r") pushNewline(src, tokens);
    else if (ch === "#") skipLine(src);
    else if (ch === "/" && src.src[src.i + 1] === "/") skipLine(src);
    else if (ch === "/" && src.src[src.i + 1] === "*") skipBlockComment(src);
    else if (ch === "\"") tokens.push(readString(src));
    else if (ch === "<" && src.src[src.i + 1] === "<") tokens.push(readHeredoc(src));
    else if (isIdentStart(ch)) tokens.push({ t: "id", v: readIdent(src), line: src.line });
    else if (isDigit(ch)) tokens.push({ t: "num", v: readNumber(src), line: src.line });
    else {
      tokens.push({ t: "punct", v: ch, line: src.line });
      src.i += 1;
    }
  }
  return tokens;
}

function pushNewline(src: Src, tokens: Token[]): void {
  tokens.push({ t: "nl", line: src.line });
  if (src.src[src.i] === "\r" && src.src[src.i + 1] === "\n") src.i += 2;
  else src.i += 1;
  src.line += 1;
}

function skipLine(src: Src): void {
  while (src.i < src.src.length && src.src[src.i] !== "\n" && src.src[src.i] !== "\r") src.i += 1;
}

function skipBlockComment(src: Src): void {
  const line = src.line;
  src.i += 2;
  while (src.i < src.src.length && !(src.src[src.i] === "*" && src.src[src.i + 1] === "/")) {
    if (src.src[src.i] === "\n") src.line += 1;
    src.i += 1;
  }
  if (src.i >= src.src.length) throw new Error(`${src.file}:${line}: unterminated comment`);
  src.i += 2;
}

function readString(src: Src): Token {
  const line = src.line;
  src.i += 1;
  let raw = "";
  while (src.i < src.src.length) {
    const ch = src.src[src.i] ?? "";
    if (ch === "\"") {
      src.i += 1;
      const decoded = templateLiteral(unescapeHcl(raw, src.file, line));
      return { t: "str", v: decoded.value, interp: decoded.interp, line };
    }
    if (ch === "\n") src.line += 1;
    if (ch !== "\r") raw += ch;
    src.i += 1;
  }
  throw new Error(`${src.file}:${line}: unterminated string`);
}

function readHeredoc(src: Src): Token {
  const line = src.line;
  src.i += 2;
  const indented = src.src[src.i] === "-";
  if (indented) src.i += 1;
  const marker = readIdent(src);
  if (marker === "") throw new Error(`${src.file}:${line}: unterminated heredoc`);
  if (src.src[src.i] === "\r") src.i += 1;
  if (src.src[src.i] !== "\n") throw new Error(`${src.file}:${line}: heredoc marker must end the line`);
  src.i += 1;
  src.line += 1;
  const lines: string[] = [];
  let indent = "";
  for (;;) {
    if (src.i >= src.src.length) throw new Error(`${src.file}:${line}: unterminated heredoc`);
    const text = readPhysicalLine(src);
    const closing = heredocIndent(text, marker, indented);
    if (closing !== undefined) {
      indent = closing;
      break;
    }
    lines.push(text);
  }
  const decoded = templateLiteral(dedentHeredoc(lines, indent));
  return { t: "heredoc", v: decoded.value, interp: decoded.interp, line };
}

function readPhysicalLine(src: Src): string {
  const start = src.i;
  while (src.i < src.src.length && src.src[src.i] !== "\n" && src.src[src.i] !== "\r") src.i += 1;
  const text = src.src.slice(start, src.i);
  if (src.src[src.i] === "\r") src.i += 1;
  if (src.src[src.i] === "\n") src.i += 1;
  src.line += 1;
  return text;
}

function heredocIndent(text: string, marker: string, indented: boolean): string | undefined {
  if (!indented) return text === marker ? "" : undefined;
  const match = new RegExp(`^([ \\t]*)${escapeRegExp(marker)}[ \\t]*$`).exec(text);
  if (!match) return undefined;
  return match[1] ?? "";
}

function dedentHeredoc(lines: string[], indent: string): string {
  if (lines.length === 0) return "";
  const stripped = lines.map((line) => (indent !== "" && line.startsWith(indent) ? line.slice(indent.length) : line));
  return `${stripped.join("\n")}\n`;
}

function unescapeHcl(body: string, file: string, line: number): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? "";
    if (ch !== "\\") {
      out += ch;
      i += 1;
    } else {
      const escaped = escapedChar(body[i + 1] ?? "", body, i + 2, file, line);
      out += escaped.char;
      i = escaped.next;
    }
  }
  return out;
}

function escapedChar(next: string, body: string, hexAt: number, file: string, line: number): { char: string; next: number } {
  if (next === "n") return { char: "\n", next: hexAt };
  if (next === "r") return { char: "\r", next: hexAt };
  if (next === "t") return { char: "\t", next: hexAt };
  if (next === "\"" || next === "\\") return { char: next, next: hexAt };
  if (next === "u") return unicodeEscape(body, hexAt, file, line);
  throw new Error(`${file}:${line}: invalid escape \\${next}`);
}

function unicodeEscape(body: string, hexAt: number, file: string, line: number): { char: string; next: number } {
  const hex = body.slice(hexAt, hexAt + UNICODE_ESCAPE_DIGITS);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`${file}:${line}: invalid unicode escape`);
  return { char: String.fromCharCode(Number.parseInt(hex, 16)), next: hexAt + UNICODE_ESCAPE_DIGITS };
}

function templateLiteral(raw: string): { value: string; interp: boolean } {
  const masked = raw.split("$${").join(DOLLAR_PLACEHOLDER).split("%%{").join(PERCENT_PLACEHOLDER);
  const interp = masked.includes("${") || masked.includes("%{");
  const value = masked.split(DOLLAR_PLACEHOLDER).join("${").split(PERCENT_PLACEHOLDER).join("%{");
  return { value, interp };
}

function readIdent(src: Src): string {
  const start = src.i;
  if (src.i < src.src.length && isIdentStart(src.src[src.i] ?? "")) {
    src.i += 1;
    while (src.i < src.src.length && isIdentChar(src.src[src.i] ?? "")) src.i += 1;
  }
  return src.src.slice(start, src.i);
}

function readNumber(src: Src): string {
  const start = src.i;
  while (src.i < src.src.length && isDigit(src.src[src.i] ?? "")) src.i += 1;
  if (src.src[src.i] === "." && isDigit(src.src[src.i + 1] ?? "")) {
    src.i += 1;
    while (src.i < src.src.length && isDigit(src.src[src.i] ?? "")) src.i += 1;
  }
  return src.src.slice(start, src.i);
}

function isIdentStart(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseItems(c: Cursor, stop: "block" | "eof"): HclItem[] {
  const items: HclItem[] = [];
  while (c.i < c.tokens.length) {
    skipSeparators(c);
    const tok = c.tokens[c.i];
    if (!tok) break;
    if (stop === "block" && tok.t === "punct" && tok.v === "}") break;
    items.push(parseItem(c));
  }
  return items;
}

function parseItem(c: Cursor): HclItem {
  const keyTok = bump(c);
  if (keyTok.t !== "id" && keyTok.t !== "str") fail(c, "expected an attribute or block");
  const key = keyTok.t === "id" || keyTok.t === "str" ? keyTok.v : "";
  skipNl(c);
  const next = c.tokens[c.i];
  if (next?.t === "punct" && next.v === "=") {
    bump(c);
    return { kind: "attr", key, value: parseValue(c) };
  }
  const labels: string[] = [];
  while (c.tokens[c.i]?.t === "str") {
    const label = bump(c);
    if (label.t === "str") labels.push(label.v);
    skipNl(c);
  }
  return { kind: "block", block: parseBlock(c, key, labels) };
}

function parseBlock(c: Cursor, type: string, labels: string[]): HclBlock {
  const open = bump(c);
  if (open.t !== "punct" || open.v !== "{") fail(c, `expected { after ${type}`);
  const items = parseItems(c, "block");
  const close = bump(c);
  if (close.t !== "punct" || close.v !== "}") fail(c, `expected } to close ${type}`);
  return { type, labels, items };
}

function parseValue(c: Cursor): HclValue {
  skipNl(c);
  const primary = parsePrimary(c);
  if (isValueEnd(c.tokens[c.i]) || startsNextItem(c)) return primary;
  skipExpressionTail(c);
  return { kind: "skip" };
}

function startsNextItem(c: Cursor): boolean {
  let i = c.i;
  const first = c.tokens[i];
  if (!first || (first.t !== "id" && first.t !== "str")) return false;
  i += 1;
  i = skipNlIndex(c, i);
  const immediate = c.tokens[i];
  if (immediate?.t === "punct" && (immediate.v === "=" || immediate.v === "{")) return true;
  while (c.tokens[i]?.t === "str") {
    i += 1;
    i = skipNlIndex(c, i);
  }
  const after = c.tokens[i];
  return after?.t === "punct" && (after.v === "=" || after.v === "{");
}

function skipNlIndex(c: Cursor, index: number): number {
  let i = index;
  while (c.tokens[i]?.t === "nl") i += 1;
  return i;
}

function parsePrimary(c: Cursor): HclValue {
  const tok = bump(c);
  if (tok.t === "str" || tok.t === "heredoc") return tok.interp ? { kind: "skip" } : { kind: "literal", value: tok.v };
  if (tok.t === "num") return { kind: "literal", value: tok.v };
  if (tok.t === "punct" && tok.v === "{") return parseObject(c);
  if (tok.t === "punct" && tok.v === "[") return parseList(c);
  if (tok.t === "punct" && tok.v === "(") return parseGroup(c);
  if (tok.t === "punct" && tok.v === "-" && c.tokens[c.i]?.t === "num") return negativeNumber(c);
  if (tok.t === "id" && (tok.v === "true" || tok.v === "false")) return { kind: "literal", value: tok.v };
  if (tok.t === "id" && tok.v === "var") return parseVarRef(c);
  return { kind: "skip" };
}

function parseVarRef(c: Cursor): HclValue {
  const dot = c.tokens[c.i];
  const ident = c.tokens[c.i + 1];
  if (dot?.t !== "punct" || dot.v !== "." || ident?.t !== "id") return { kind: "skip" };
  c.i += 2;
  const more = c.tokens[c.i];
  if (more?.t === "punct" && (more.v === "." || more.v === "[")) return { kind: "skip" };
  return { kind: "var", name: ident.v };
}

function negativeNumber(c: Cursor): HclValue {
  const num = bump(c);
  return num.t === "num" ? { kind: "literal", value: `-${num.v}` } : { kind: "skip" };
}

function parseGroup(c: Cursor): HclValue {
  const inner = parseValue(c);
  const close = bump(c);
  if (close.t !== "punct" || close.v !== ")") fail(c, "expected )");
  return inner;
}

function parseObject(c: Cursor): HclValue {
  skipSeparators(c);
  const first = c.tokens[c.i];
  if (first?.t === "id" && first.v === "for") {
    skipBracket(c, "{", "}");
    return { kind: "skip" };
  }
  const entries: { key: string; value: HclValue }[] = [];
  while (c.i < c.tokens.length) {
    skipSeparators(c);
    const tok = c.tokens[c.i];
    if (!tok) fail(c, "unterminated object");
    if (tok.t === "punct" && tok.v === "}") {
      bump(c);
      return { kind: "object", entries };
    }
    const item = parseItem(c);
    if (item.kind === "attr") entries.push({ key: item.key, value: item.value });
  }
  fail(c, "unterminated object");
}

function parseList(c: Cursor): HclValue {
  skipSeparators(c);
  const first = c.tokens[c.i];
  if (first?.t === "id" && first.v === "for") {
    skipBracket(c, "[", "]");
    return { kind: "skip" };
  }
  const items: HclValue[] = [];
  while (c.i < c.tokens.length) {
    skipSeparators(c);
    const tok = c.tokens[c.i];
    if (!tok) fail(c, "unterminated list");
    if (tok.t === "punct" && tok.v === "]") {
      bump(c);
      return { kind: "list", items };
    }
    items.push(parseValue(c));
  }
  fail(c, "unterminated list");
}

function skipExpressionTail(c: Cursor): void {
  while (!isValueEnd(c.tokens[c.i])) {
    const tok = bump(c);
    if (tok.t === "punct" && (tok.v === "{" || tok.v === "[" || tok.v === "(")) {
      skipBracket(c, tok.v, closingPunct(tok.v));
    }
  }
}

function closingPunct(open: string): string {
  if (open === "{") return "}";
  if (open === "[") return "]";
  return ")";
}

function skipBracket(c: Cursor, open: string, close: string): void {
  let depth = 1;
  while (depth > 0) {
    const tok = bump(c);
    if (tok.t === "punct" && tok.v === open) depth += 1;
    else if (tok.t === "punct" && tok.v === close) depth -= 1;
  }
}

function isValueEnd(tok: Token | undefined): boolean {
  if (!tok || tok.t === "nl") return true;
  return tok.t === "punct" && (tok.v === "," || tok.v === "}" || tok.v === "]" || tok.v === ")");
}

function skipSeparators(c: Cursor): void {
  while (c.i < c.tokens.length) {
    const tok = c.tokens[c.i];
    if (tok?.t === "nl" || (tok?.t === "punct" && tok.v === ",")) c.i += 1;
    else break;
  }
}

function skipNl(c: Cursor): void {
  while (c.tokens[c.i]?.t === "nl") c.i += 1;
}

function bump(c: Cursor): Token {
  const tok = c.tokens[c.i];
  if (!tok) fail(c, "unexpected end of file");
  c.i += 1;
  return tok;
}

function fail(c: Cursor, message: string): never {
  const line = c.tokens[c.i]?.line ?? c.tokens[c.tokens.length - 1]?.line ?? 1;
  throw new Error(`${c.file}:${line}: ${message}`);
}
