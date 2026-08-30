import "./gcp-env.ts";
import { existsSync } from "node:fs";
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
} from "./errors.ts";
import { emptyIdentity, type Identity } from "./identity.ts";

export type GoogleStatus = {
  gcloudInstalled: boolean;
  adcAvailable: boolean;
  userEmail: string;
  projectID: string;
  projectSource: string;
  error?: Error;
};

const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

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
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (includesAny(msg, ["unauth", "invalid_grant", "token has been expired", "expired"])) {
    return hintError(KindAuthentication, "credential expired or invalid", "run `devctl auth login` or `gcloud auth application-default login`");
  }
  if (includesAny(msg, ["permission", "forbidden", "iam"])) {
    if (includesAny(msg, ["serviceaccounttoken", "iamcredentials", "token creator"])) {
      return hintError(KindImpersonation, "cannot impersonate service account", "ask an administrator to grant roles/iam.serviceAccountTokenCreator on the target service account");
    }
    return hintError(KindAuthorization, "authorization failure", "verify IAM permissions for the current user on this project");
  }
  if (includesAny(msg, ["api has not been used", "has not been enabled", "access not configured"])) {
    return hintError(KindAuthorization, "required Google API is not enabled", "ask an administrator to enable the API; devctl will not enable APIs automatically");
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

async function hasCommand(name: string): Promise<boolean> {
  const proc = spawn({
    cmd: ["which", name],
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

function hasLocalAdcMaterial(): boolean {
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
    const proc = spawn({
      cmd: ["gcloud", "config", "get-value", key],
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      return "";
    }
    const v = text.trim();
    if (v === "" || v === "(unset)") {
      return "";
    }
    return v;
  } catch {
    return "";
  }
}
