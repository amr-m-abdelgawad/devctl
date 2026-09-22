import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "bun";
import type { DevctlConfig } from "../../domain/config/types.ts";

const SOPS_DECRYPT_TIMEOUT_MS = 30_000;
const SOPS_STDOUT_MAX_BYTES = 1024 * 1024;
const SOPS_STDERR_MAX_BYTES = 8 * 1024;
const SOPS_STDERR_CLIP = 240;
const SOPS_INPUT_TYPES = ["json", "yaml", "dotenv"] as const;

export type SopsCommandResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; reason: "not_found" | "failed"; detail: string };

export type SopsCommandRunner = (spec: { cmd: string[]; cwd: string }) => Promise<SopsCommandResult>;

export type SopsLoadResult = {
  values: Record<string, string>;
  warning?: string;
};

type LocatedFile = { path: string } | { error: string };

export function sopsConfigIssues(cfg: DevctlConfig): string[] {
  const sops = cfg.environment.sops;
  const issues: string[] = [];
  const enabled = cfg.environment.sources.includes("sops");
  if (enabled && sops.file.trim() === "") {
    issues.push("environment.sops.file is required when environment.sources includes sops");
  }
  const inputIssue = sopsInputTypeIssue(sops.input_type);
  if (inputIssue) {
    issues.push(inputIssue);
  }
  if (sops.file.trim() !== "") {
    const located = resolveSopsFile(cfg.repoRoot, sops.file);
    if ("error" in located) {
      issues.push(located.error);
    }
  }
  for (const [envName, sopsKey] of Object.entries(sops.key_map)) {
    if (sopsKey.trim() === "") {
      issues.push(`environment.sops.key_map.${envName} must name a SOPS key`);
    }
  }
  return issues;
}

export function mapSopsKeys(decrypted: Record<string, string>, keyMap: Record<string, string>): Record<string, string> {
  if (Object.keys(keyMap).length === 0) {
    return uppercaseKeys(decrypted);
  }
  const mappedSopsKeys = new Set(Object.values(keyMap));
  const out = uppercaseKeys(entriesExcept(decrypted, mappedSopsKeys));
  for (const [envName, sopsKey] of Object.entries(keyMap)) {
    const value = decrypted[sopsKey];
    if (value !== undefined) {
      out[envName] = value;
    }
  }
  return out;
}

export function detectSopsInputType(file: string): string {
  const base = file.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  const name = base.endsWith(".enc") ? base.slice(0, -".enc".length) : base;
  if (name.endsWith(".json")) {
    return "json";
  }
  if (name.endsWith(".yaml") || name.endsWith(".yml")) {
    return "yaml";
  }
  if (name.endsWith(".env") || name.endsWith(".dotenv")) {
    return "dotenv";
  }
  return "";
}

export function sopsDecryptArgs(file: string, inputType: string): string[] {
  // JSON, not dotenv. SOPS refuses nested values in dotenv output, and a
  // dotenv parser truncates `#`, trims spaces, and leaves `\n` escapes as
  // two characters. JSON keeps the decrypted strings.
  const args = ["sops", "--decrypt", "--output-type", "json"];
  const selected = normalizeSopsInputType(inputType) || detectSopsInputType(file);
  if (selected !== "") {
    args.push("--input-type", selected);
  }
  args.push(file);
  return args;
}

export async function loadSopsEnvironment(cfg: DevctlConfig, run: SopsCommandRunner = bunSopsRunner): Promise<SopsLoadResult> {
  if (!cfg.environment.sources.includes("sops")) {
    return { values: {} };
  }
  const located = resolveSopsFile(cfg.repoRoot, cfg.environment.sops.file);
  if ("error" in located) {
    return { values: {}, warning: skip(located.error) };
  }
  if (!existsSync(located.path)) {
    return { values: {}, warning: skip(`file not found: ${cfg.environment.sops.file}`) };
  }
  const result = await run({ cmd: sopsDecryptArgs(located.path, cfg.environment.sops.input_type), cwd: cfg.repoRoot });
  if (!result.ok) {
    const detail = result.reason === "not_found" ? "sops is not on PATH" : result.detail;
    return { values: {}, warning: skip(detail) };
  }
  if (result.code !== 0) {
    return { values: {}, warning: skip(clip(result.stderr) || `sops --decrypt exited ${result.code}`) };
  }
  const parsed = parseDecrypted(result.stdout);
  if ("error" in parsed) {
    return { values: {}, warning: skip(parsed.error) };
  }
  const values = mapSopsKeys(parsed.values, cfg.environment.sops.key_map);
  const missing = missingMappedKeys(parsed.values, cfg.environment.sops.key_map);
  if (missing.length > 0) {
    return { values, warning: `sops key_map references missing keys: ${missing.join(", ")}` };
  }
  return { values };
}

export async function bunSopsRunner(spec: { cmd: string[]; cwd: string }): Promise<SopsCommandResult> {
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn({
      cmd: spec.cmd,
      cwd: spec.cwd,
      env: spawnEnv(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: SOPS_DECRYPT_TIMEOUT_MS,
    });
  } catch (err) {
    if (isNotFound(err)) {
      return { ok: false, reason: "not_found", detail: "sops is not on PATH" };
    }
    const message = err instanceof Error ? err.message : "failed to run sops";
    return { ok: false, reason: "failed", detail: clip(message) };
  }
  const [stdout, stderr, code] = await Promise.all([
    readCapped(proc.stdout, SOPS_STDOUT_MAX_BYTES),
    readCapped(proc.stderr, SOPS_STDERR_MAX_BYTES),
    proc.exited,
  ]);
  if (proc.killed) {
    proc.kill();
    return { ok: false, reason: "failed", detail: "sops --decrypt timed out" };
  }
  if (stdout.truncated) {
    proc.kill();
    return { ok: false, reason: "failed", detail: "decrypted output exceeded 1 MiB" };
  }
  return { ok: true, stdout: stdout.text, stderr: stderr.text, code: typeof code === "number" ? code : 1 };
}

export function envSignature(values: Record<string, string>): string {
  const keys = Object.keys(values).sort();
  return JSON.stringify(keys.map((key) => [key, values[key]]));
}

function sopsInputTypeIssue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || normalizeSopsInputType(trimmed) !== "") {
    return undefined;
  }
  return "environment.sops.input_type must be json, yaml, or dotenv";
}

function normalizeSopsInputType(value: string): string {
  const lower = value.trim().toLowerCase();
  return (SOPS_INPUT_TYPES as readonly string[]).includes(lower) ? lower : "";
}

function resolveSopsFile(repoRoot: string, file: string): LocatedFile {
  const trimmed = file.trim();
  if (trimmed === "") {
    return { error: "environment.sops.file is empty" };
  }
  const root = resolve(repoRoot);
  const abs = resolve(root, trimmed);
  if (!isInside(root, abs)) {
    return { error: "environment.sops.file must stay inside the repository" };
  }
  if (!existsSync(abs)) {
    return { path: abs };
  }
  try {
    const realRoot = realpathSync(root);
    const realFile = realpathSync(abs);
    if (!isInside(realRoot, realFile)) {
      return { error: "environment.sops.file must stay inside the repository" };
    }
    return { path: realFile };
  } catch {
    return { path: abs };
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") {
    return true;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function uppercaseKeys(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    out[injectedName(key)] = value;
  }
  return out;
}

function injectedName(key: string): string {
  return key.replaceAll(".", "_").toUpperCase();
}

function entriesExcept(input: Record<string, string>, excluded: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!excluded.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

function missingMappedKeys(decrypted: Record<string, string>, keyMap: Record<string, string>): string[] {
  const missing: string[] = [];
  for (const [envName, sopsKey] of Object.entries(keyMap)) {
    if (decrypted[sopsKey] === undefined) {
      missing.push(`${envName}→${sopsKey}`);
    }
  }
  return missing;
}

function parseDecrypted(stdout: string): { values: Record<string, string> } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { error: "could not parse sops json output" };
  }
  if (!isPlainRecord(parsed)) {
    return { error: "sops json output was not an object" };
  }
  const values: Record<string, string> = {};
  collectSopsLeaves(parsed, "", values);
  return { values };
}

function collectSopsLeaves(value: Record<string, unknown>, prefix: string, out: Record<string, string>): void {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainRecord(item)) {
      collectSopsLeaves(item, path, out);
    } else {
      const rendered = renderSopsLeaf(item);
      if (rendered !== undefined) {
        out[path] = rendered;
      }
    }
  }
}

function renderSopsLeaf(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skip(detail: string): string {
  return `sops environment source skipped: ${detail}`;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= SOPS_STDERR_CLIP) {
    return line;
  }
  return `${line.slice(0, SOPS_STDERR_CLIP)}…`;
}

function spawnEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function isByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object" && value !== null && "getReader" in value && typeof value.getReader === "function";
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  if ("code" in err && err.code === "ENOENT") {
    return true;
  }
  return err instanceof Error && err.message.includes("Executable not found");
}

async function readCapped(stream: unknown, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!isByteStream(stream)) {
    return { text: "", truncated: false };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(next.value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}
