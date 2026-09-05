import "./gcp-env.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import type { GoogleAuth } from "google-auth-library";
import {
  hintError,
  KindAuthentication,
  KindAuthorization,
  KindConfiguration,
  KindGeneral,
  KindIAP,
  KindImpersonation,
  wrapError,
} from "../../shared/errors.ts";
import { emptyIdentity, type Identity } from "../../domain/identity/identity.ts";

export type GoogleStatus = {
  gcloudInstalled: boolean;
  adcAvailable: boolean;
  userEmail: string;
  projectID: string;
  projectSource: string;
  error?: Error;
};

const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const COMMAND_PROBE_MS = 1_500;
const ADC_PROBE_MS = 2_000;

/**
 * OpenTUI's CliRenderer sets `global.window = {}` (for a requestAnimationFrame shim) as soon as
 * the TUI starts rendering. gaxios's fetch-implementation detection treats the mere presence of a
 * global `window` as a signal that it's running in a browser and unconditionally uses
 * `window.fetch` — which OpenTUI never defines — instead of falling back to Bun/Node's native
 * `fetch`. The result is every Google API call failing with "fetchImpl is not a function" the
 * moment devctl runs inside the interactive TUI, while the plain CLI (no `window` global) is
 * unaffected. This has nothing to do with credentials, IAM, or enabled APIs — call this before any
 * gaxios-backed request to make sure `window.fetch`, if `window` exists at all, points at the real
 * fetch implementation.
 */
export function ensureFetchShim(): void {
  const g = globalThis as unknown as { window?: { fetch?: typeof fetch } };
  if (g.window && typeof g.window.fetch !== "function") {
    g.window.fetch = fetch;
  }
}

export function adcQuotaProject(): string {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(homedir(), ".config", "gcloud", "application_default_credentials.json");
  if (!existsSync(path)) {
    return "";
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { quota_project_id?: unknown };
    return typeof parsed.quota_project_id === "string" ? parsed.quota_project_id : "";
  } catch {
    return "";
  }
}

export async function detectGoogle(configuredProject: string): Promise<GoogleStatus> {
  const st: GoogleStatus = {
    gcloudInstalled: await hasCommand("gcloud"),
    adcAvailable: false,
    userEmail: "",
    projectID: "",
    projectSource: "",
  };
  if (configuredProject !== "") {
    st.projectID = configuredProject;
    st.projectSource = "configuration";
  } else {
    const env = firstEnv("GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_PROJECT");
    if (env !== "") {
      st.projectID = env;
      st.projectSource = "environment variable";
    } else if (st.gcloudInstalled) {
      const gcloudProject = await gcloudConfig("core/project");
      if (gcloudProject !== "") {
        st.projectID = gcloudProject;
        st.projectSource = "gcloud configuration";
      }
    }
  }
  if (hasLocalAdcMaterial()) {
    try {
      await withDeadline(fillAdc(st), ADC_PROBE_MS);
    } catch (err) {
      st.adcAvailable = false;
      st.error = classifyGoogle(err);
    }
  }
  if (st.userEmail === "" && st.gcloudInstalled) {
    st.userEmail = await gcloudConfig("core/account");
  }
  return st;
}

async function fillAdc(st: GoogleStatus): Promise<void> {
  ensureFetchShim();
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: [CLOUD_SCOPE] });
  await auth.getClient();
  st.adcAvailable = true;
  const project = await auth.getProjectId().catch(() => "");
  if (st.projectID === "" && project) {
    st.projectID = project;
    st.projectSource = "application default credentials";
  }
  const email = await emailFromAuth(auth);
  if (email !== "") {
    st.userEmail = email;
  }
}

async function emailFromAuth(auth: GoogleAuth): Promise<string> {
  try {
    const creds = await auth.getCredentials();
    if (creds.client_email) {
      return creds.client_email;
    }
  } catch {
    // fall through to id token / gcloud
  }
  try {
    const client = await auth.getClient();
    const idToken = typeof client.credentials?.id_token === "string" ? client.credentials.id_token : "";
    if (idToken !== "") {
      const email = emailFromJwt(idToken);
      if (email !== "") {
        return email;
      }
    }
  } catch {
    return "";
  }
  return "";
}

function emailFromJwt(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return "";
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { email?: string };
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

export async function detectIdentity(configuredProject: string): Promise<Identity> {
  const st = await detectGoogle(configuredProject);
  return emptyIdentity({
    kind: "user",
    email: st.userEmail,
    project: st.projectID,
    projectSource: st.projectSource,
    adcAvailable: st.adcAvailable,
  });
}

export async function loginGoogle(): Promise<void> {
  const proc = spawn({
    cmd: ["gcloud", "auth", "application-default", "login"],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw hintError(KindAuthentication, "application-default login failed", "run `gcloud auth application-default login`");
  }
}

export async function logoutGoogle(): Promise<void> {
  const proc = spawn({
    cmd: ["gcloud", "auth", "application-default", "revoke", "--quiet"],
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw hintError(KindAuthentication, "failed to revoke application-default credentials", "run `gcloud auth application-default revoke`");
  }
}

export function classifyGoogle(err: unknown): Error {
  const msg = googleErrorText(err).toLowerCase();
  if (includesAny(msg, ["unauth", "invalid_grant", "token has been expired", "expired"])) {
    return hintError(KindAuthentication, "credential expired or invalid", "run `devctl auth login` or `gcloud auth application-default login`");
  }
  // Disabled Google APIs commonly return a 403 containing both "permission"
  // and "iamcredentials". Match the specific cause before generic IAM errors.
  if (includesAny(msg, ["api has not been used", "has not been enabled", "access not configured", "service_disabled"])) {
    return hintError(KindAuthorization, "required Google API is not enabled", "enable the API in the target service account project; devctl will not enable APIs automatically");
  }
  if (includesAny(msg, ["permission", "forbidden", "iam"])) {
    if (includesAny(msg, ["serviceaccounttoken", "iamcredentials", "token creator", "getaccesstoken"])) {
      return hintError(KindImpersonation, "cannot impersonate service account", "ask an administrator to grant roles/iam.serviceAccountTokenCreator on the target service account");
    }
    return hintError(KindAuthorization, "authorization failure", "verify IAM permissions for the current user on this project");
  }
  if (msg.includes("audience")) {
    return hintError(KindIAP, "IAP audience is incorrect", "set auth.audience on the proxy route to the IAP OAuth client ID");
  }
  if (msg.includes("iap")) {
    return wrapError(KindIAP, "IAP authentication failure", err);
  }
  if (msg.includes("project")) {
    return hintError(KindConfiguration, "wrong or missing Google project", "set google.project_id in .devctl/config.yaml");
  }
  if (includesAny(msg, ["timeout", "network", "connection refused", "no such host"])) {
    return wrapError(KindGeneral, "network problem reaching Google Cloud", err);
  }
  if (includesAny(msg, ["adc", "default credentials", "could not find"])) {
    return hintError(KindAuthentication, "application default credentials unavailable", "run `gcloud auth application-default login`");
  }
  return wrapError(KindAuthentication, "Google authentication failed", err);
}

function googleErrorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 8 || seen.has(value)) {
      return;
    }
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["message", "reason", "status", "code", "error_description", "permission", "service"]) {
      visit(record[key], depth + 1);
    }
    for (const key of ["error", "errors", "details", "response", "data", "cause", "metadata"]) {
      const child = record[key];
      if (Array.isArray(child)) {
        child.forEach((item) => visit(item, depth + 1));
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(err, 0);
  return parts.length > 0 ? parts.join(" ") : String(err);
}

function includesAny(msg: string, parts: string[]): boolean {
  return parts.some((part) => msg.includes(part));
}

function firstEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      return value;
    }
  }
  return "";
}

export async function hasCommand(name: string): Promise<boolean> {
  try {
    const result = await spawnTimed(
      process.platform === "win32" ? ["where", name] : ["which", name],
      COMMAND_PROBE_MS,
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

export function hasLocalAdcMaterial(): boolean {
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fromEnv && existsSync(fromEnv)) {
    return true;
  }
  if (existsSync(join(homedir(), ".config", "gcloud", "application_default_credentials.json"))) {
    return true;
  }
  const appData = process.env.APPDATA;
  return Boolean(appData && existsSync(join(appData, "gcloud", "application_default_credentials.json")));
}

async function gcloudConfig(key: string): Promise<string> {
  try {
    const result = await spawnTimed(["gcloud", "config", "get-value", key], COMMAND_PROBE_MS);
    if (result.code !== 0) {
      return "";
    }
    const value = result.stdout.trim();
    if (value === "" || value === "(unset)") {
      return "";
    }
    return value;
  } catch {
    return "";
  }
}

async function spawnTimed(cmd: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  const proc = spawn({
    cmd,
    stdout: "pipe",
    stderr: "ignore",
    env: {
      ...process.env,
      CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
      CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
    },
  });
  const stdoutP = proc.stdout ? new Response(proc.stdout).text() : Promise.resolve("");
  try {
    const [stdout, code] = await withDeadline(Promise.all([stdoutP, proc.exited]), timeoutMs);
    return { code: code ?? 1, stdout };
  } catch {
    proc.kill();
    return { code: 1, stdout: "" };
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
