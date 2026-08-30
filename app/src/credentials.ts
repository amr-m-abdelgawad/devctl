import { spawn } from "bun";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, writeFileSecure } from "./storage.ts";

const INDEX_FILE = "keychain-index.json";

export type CredentialRecord = {
  identity: string;
  audience: string;
  scopes: string[];
  accessToken: string;
  tokenType: string;
  expiresAt: string;
};

export type CredentialStatus = {
  key: string;
  identity: string;
  audience: string;
  scopes: string[];
  expires_at: string;
  valid: boolean;
};

export type CredentialBackend = "keychain" | "file";

export type CredentialStore = {
  readonly backend: CredentialBackend;
  get: (key: string) => Promise<CredentialRecord | undefined>;
  set: (key: string, record: CredentialRecord) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: () => Promise<CredentialStatus[]>;
};

const SERVICE = "devctl.credentials";
const FILE_SUFFIX = ".cred.json";

export function credentialFilePath(key: string): string {
  return join(credentialsDir(), `${safeKey(key)}${FILE_SUFFIX}`);
}

export function openCredentialStore(preferred?: CredentialBackend): CredentialStore {
  if (preferred === "file" || (process.env.DEVCTL_HOME && preferred !== "keychain")) {
    return new FileCredentialStore();
  }
  if (preferred === "keychain" || process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") {
    return new KeychainCredentialStore(new FileCredentialStore());
  }
  return new FileCredentialStore();
}

class FileCredentialStore implements CredentialStore {
  readonly backend: CredentialBackend = "file";

  async get(key: string): Promise<CredentialRecord | undefined> {
    const rec = readFileRecord(key);
    if (!rec || rec.accessToken === "") {
      return undefined;
    }
    return rec;
  }

  async set(key: string, record: CredentialRecord): Promise<void> {
    writeFileSecure(credentialFilePath(key), `${JSON.stringify(fileSafeRecord(record))}\n`);
  }

  async delete(key: string): Promise<void> {
    const path = credentialFilePath(key);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  async list(): Promise<CredentialStatus[]> {
    const dir = credentialsDir();
    if (!existsSync(dir)) {
      return [];
    }
    const out: CredentialStatus[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(FILE_SUFFIX)) {
        continue;
      }
      const key = name.slice(0, -FILE_SUFFIX.length);
      const rec = readFileRecord(key);
      if (!rec) {
        continue;
      }
      out.push(statusOf(key, rec));
    }
    return out.sort((a, b) => a.identity.localeCompare(b.identity));
  }
}

class KeychainCredentialStore implements CredentialStore {
  readonly backend: CredentialBackend = "keychain";
  private readonly fallback: FileCredentialStore;

  constructor(fallback: FileCredentialStore) {
    this.fallback = fallback;
  }

  async get(key: string): Promise<CredentialRecord | undefined> {
    const fromChain = await keychainGet(key);
    if (fromChain) {
      return fromChain;
    }
    return this.fallback.get(key);
  }

  async set(key: string, record: CredentialRecord): Promise<void> {
    const stored = await keychainSet(key, record);
    if (!stored) {
      await this.fallback.set(key, record);
    }
    rememberKey(key);
  }

  async delete(key: string): Promise<void> {
    await keychainDelete(key);
    await this.fallback.delete(key);
  }

  async list(): Promise<CredentialStatus[]> {
    const keys = new Set(rememberedKeys());
    const fromFile = await this.fallback.list();
    const out = new Map<string, CredentialStatus>();
    for (const entry of fromFile) {
      out.set(entry.key, entry);
    }
    for (const key of keys) {
      const rec = await this.get(key);
      if (rec) {
        out.set(key, statusOf(key, rec));
      }
    }
    return [...out.values()].sort((a, b) => a.identity.localeCompare(b.identity));
  }
}

function rememberKey(key: string): void {
  const keys = rememberedKeys();
  if (!keys.includes(key)) {
    writeFileSecure(join(credentialsDir(), INDEX_FILE), `${JSON.stringify([...keys, key])}\n`);
  }
}

function rememberedKeys(): string[] {
  const path = join(credentialsDir(), INDEX_FILE);
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function fileSafeRecord(record: CredentialRecord): CredentialRecord {
  return { ...record, accessToken: "" };
}

function readFileRecord(key: string): CredentialRecord | undefined {
  const path = credentialFilePath(key);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialRecord>;
    if (typeof parsed.identity !== "string") {
      return undefined;
    }
    return {
      identity: parsed.identity,
      audience: typeof parsed.audience === "string" ? parsed.audience : "",
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((item): item is string => typeof item === "string") : [],
      accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : "",
      tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : "Bearer",
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : "",
    };
  } catch {
    return undefined;
  }
}

function statusOf(key: string, rec: CredentialRecord): CredentialStatus {
  const expires = Date.parse(rec.expiresAt);
  return {
    key,
    identity: rec.identity,
    audience: rec.audience,
    scopes: rec.scopes,
    expires_at: rec.expiresAt,
    valid: Number.isFinite(expires) && expires - Date.now() > 0,
  };
}

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._|-]+/g, "_").slice(0, 80) || "token";
}

async function keychainGet(key: string): Promise<CredentialRecord | undefined> {
  const raw = await runKeychainRead(key);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as CredentialRecord;
  } catch {
    return undefined;
  }
}

async function keychainSet(key: string, record: CredentialRecord): Promise<boolean> {
  const payload = JSON.stringify(record);
  if (process.platform === "darwin") {
    await run(["security", "delete-generic-password", "-s", SERVICE, "-a", key]);
    const code = await run(["security", "add-generic-password", "-s", SERVICE, "-a", key, "-w", payload, "-U"]);
    return code === 0;
  }
  if (process.platform === "linux") {
    const code = await runWithStdin(["secret-tool", "store", "--label", `devctl ${key}`, "service", SERVICE, "account", key], payload);
    return code === 0;
  }
  if (process.platform === "win32") {
    const encoded = Buffer.from(payload, "utf8").toString("base64");
    const script = `Add-Type -AssemblyName System.Security; $bytes = [Convert]::FromBase64String('${encoded}'); $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'); [IO.File]::WriteAllBytes($env:LOCALAPPDATA + '\\devctl-cred-${safeKey(key)}.bin', $enc)`;
    const code = await run(["powershell", "-NoProfile", "-Command", script]);
    return code === 0;
  }
  return false;
}

async function keychainDelete(key: string): Promise<void> {
  if (process.platform === "darwin") {
    await run(["security", "delete-generic-password", "-s", SERVICE, "-a", key]);
    return;
  }
  if (process.platform === "linux") {
    await run(["secret-tool", "clear", "service", SERVICE, "account", key]);
    return;
  }
  if (process.platform === "win32") {
    await run(["powershell", "-NoProfile", "-Command", `Remove-Item -ErrorAction SilentlyContinue ($env:LOCALAPPDATA + '\\devctl-cred-${safeKey(key)}.bin')`]);
  }
}

async function runKeychainRead(key: string): Promise<string | undefined> {
  if (process.platform === "darwin") {
    const result = await runCapture(["security", "find-generic-password", "-s", SERVICE, "-a", key, "-w"]);
    return result.code === 0 && result.stdout !== "" ? result.stdout : undefined;
  }
  if (process.platform === "linux") {
    const result = await runCapture(["secret-tool", "lookup", "service", SERVICE, "account", key]);
    return result.code === 0 && result.stdout !== "" ? result.stdout : undefined;
  }
  if (process.platform === "win32") {
    const script = `$p = $env:LOCALAPPDATA + '\\devctl-cred-${safeKey(key)}.bin'; if (-not (Test-Path $p)) { exit 1 }; Add-Type -AssemblyName System.Security; $raw = [IO.File]::ReadAllBytes($p); $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($raw, $null, 'CurrentUser'); [Text.Encoding]::UTF8.GetString($dec)`;
    const result = await runCapture(["powershell", "-NoProfile", "-Command", script]);
    return result.code === 0 && result.stdout !== "" ? result.stdout : undefined;
  }
  return undefined;
}

async function run(cmd: string[]): Promise<number> {
  try {
    const proc = spawn({ cmd, stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
  } catch {
    return 1;
  }
}

async function runWithStdin(cmd: string[], input: string): Promise<number> {
  try {
    const proc = spawn({ cmd, stdin: new TextEncoder().encode(input), stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
  } catch {
    return 1;
  }
}

async function runCapture(cmd: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const proc = spawn({ cmd, stdout: "pipe", stderr: "ignore" });
    const text = proc.stdout ? await new Response(proc.stdout).text() : "";
    const code = await proc.exited;
    return { code, stdout: text.trim() };
  } catch {
    return { code: 1, stdout: "" };
  }
}
