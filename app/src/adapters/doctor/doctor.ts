import { readFileSync } from "node:fs";
import "../google/gcp-env.ts";
import { type DevctlConfig, validate } from "../config/index.ts";
import { versionLine } from "../../version.ts";
import { DevctlError, humanMessage } from "../../shared/errors.ts";
import { inspectIapOAuthClientFile, type IapOAuthClientInspectIssue } from "../../domain/config/iap-credentials.ts";
import { envRefsIn } from "../../domain/config/env-ref.ts";
import type { RouteAuthConfig } from "../../domain/config/types.ts";
import { adcQuotaProject, detectGoogle, hasCommand, hasLocalAdcMaterial, type GoogleStatus } from "../google/google.ts";
import { configuredServiceAccounts, fromRoute, KindServiceAccount, needsCloudFeatures } from "../../domain/identity/identity.ts";
import { isImageUserRoot } from "../../domain/service/container-limits.ts";
import { available, findPortHolder } from "../net/ports.ts";
import { openCredentialStore } from "../storage/credentials.ts";
import { TokenManager, googleTokenProviders, iapOAuthClientRef, TOKEN_MINT_WARN_COUNT, type OAuthClientRef, type TokenMintHotspot } from "../google/token.ts";
import type { Check, DoctorProgress, DoctorRuntimeContext, Report } from "../../domain/doctor/types.ts";
import type { DoctorRunner } from "../../ports/doctor-runner.ts";
export type { Severity, PortAction, Check, Report, DoctorProgress, DoctorRuntimeContext } from "../../domain/doctor/types.ts";

// Documented in docs/iap.md / docs/proxy.md. There is no `devctl run auth-iap-login`.
const IAP_CREDENTIALS_LOGIN_HINT =
  "run `gcloud auth application-default login` with a client secret file that matches `client_id` (or omit `client_id`); TUI `/auth login` or `devctl auth login`";

const LIVE_PROBE_MS = 4_000;
const LIVE_SECTION_MS = 8_000;

export type DoctorHost = {
  detectGoogle(project: string): Promise<GoogleStatus>;
  hasCommand(name: string): Promise<boolean>;
  portAvailable(port: number): Promise<boolean>;
  hasLocalAdc?: () => boolean;
  adcQuotaProject?: () => string;
  liveDeadlineMs?: number;
  mintToken?: (identity: string, audience: string, oauth?: OAuthClientRef) => Promise<void>;
  probeServiceUsage?: (project: string, service: string) => Promise<boolean>;
  containerRuntimeAvailable?: (runtime: string) => Promise<boolean>;
  mintRateWarning?: () => TokenMintHotspot | undefined;
  inspectImageUser?: (runtime: string, image: string) => Promise<string | undefined>;
};

export function createDoctorHost(deps?: { tokens?: TokenManager }): DoctorHost {
  let tokens = deps?.tokens;
  const manager = (): TokenManager => {
    tokens ??= new TokenManager(60_000, googleTokenProviders(), undefined, openCredentialStore("file"));
    return tokens;
  };
  return {
    detectGoogle,
    hasCommand,
    portAvailable: available,
    hasLocalAdc: hasLocalAdcMaterial,
    adcQuotaProject,
    mintToken: async (identity, audience, oauth) => {
      await manager().get(identity, audience, [], oauth);
    },
    mintRateWarning: () => manager().mintRateHotspot(),
    probeServiceUsage: async (project, service) => {
      const tok = await withTimeout(manager().get("user", "", []), LIVE_PROBE_MS);
      const url = `https://serviceusage.googleapis.com/v1/projects/${project}/services/${service}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${tok.accessToken}` },
        signal: AbortSignal.timeout(LIVE_PROBE_MS),
      });
      if (!resp.ok) {
        return false;
      }
      const body = await resp.json().catch(() => undefined) as { state?: string } | undefined;
      return body?.state === "ENABLED";
    },
    containerRuntimeAvailable: async (runtime) => {
      try {
        const proc = Bun.spawn({ cmd: [runtime, "info"], stdout: "ignore", stderr: "ignore", stdin: "ignore" });
        return (await proc.exited) === 0;
      } catch {
        return false;
      }
    },
    inspectImageUser: async (runtime, image) => {
      try {
        const proc = Bun.spawn({
          cmd: [runtime, "image", "inspect", "--format", "{{.Config.User}}", image],
          stdout: "pipe",
          stderr: "ignore",
          stdin: "ignore",
        });
        const [text, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
        if (code !== 0) {
          return undefined;
        }
        return text.trim();
      } catch {
        return undefined;
      }
    },
  };
}

const defaultHost: DoctorHost = createDoctorHost();

export function createDoctorRunner(host: DoctorHost = createDoctorHost()): DoctorRunner {
  return {
    run: (cfg, onProgress, runtime) => runDoctor(cfg, host, onProgress, runtime),
  };
}

export async function runDoctor(
  cfg: DevctlConfig,
  host: DoctorHost = defaultHost,
  onProgress?: (progress: DoctorProgress) => void,
  runtime?: DoctorRuntimeContext,
): Promise<Report> {
  const report: Report = { checks: [], issues: 0 };
  let active = "Preparing diagnostics";
  const publish = (): void => onProgress?.({ active, checks: [...report.checks] });
  const checking = (name: string): void => {
    active = name;
    publish();
  };
  const add = (c: Check): void => {
    report.checks.push(c);
    if (c.severity === "error") {
      report.issues += 1;
    }
    publish();
  };
  const runtimes = [...new Set(Object.values(cfg.services).flatMap((svc) => svc.container ? [svc.container.runtime || "docker"] : []))];
  for (const runtimeName of runtimes) {
    checking(`${runtimeName} container runtime`);
    const installed = await host.hasCommand(runtimeName);
    const reachable = installed && await (host.containerRuntimeAvailable ?? defaultHost.containerRuntimeAvailable!)(runtimeName);
    add(reachable
      ? { name: `${runtimeName} container runtime`, severity: "ok", message: `${runtimeName} daemon reachable` }
      : { name: `${runtimeName} container runtime`, severity: "error", message: installed ? `${runtimeName} daemon is not reachable` : `${runtimeName} not found`, hint: `install and start ${runtimeName}` });
  }
  for (const [name, svc] of Object.entries(cfg.services)) {
    const container = svc.container;
    if (container && isImageUserRoot(container.user)) {
      const imageUser = container.user !== "" ? container.user : await host.inspectImageUser?.(container.runtime || "docker", container.image);
      if (imageUser !== undefined && isImageUserRoot(imageUser)) {
        checking(`${name} container user`);
        add({
          name: `${name} container user`,
          severity: "warn",
          message: "image user is root",
          hint: "set container.user to a non-root uid, or rebuild the image with USER",
        });
      }
    }
  }
  if (cfg.plugins.length > 0) {
    checking("Config plugins");
    add({
      name: "Config plugins",
      severity: "warn",
      message: `${cfg.plugins.length} plugin(s) run in-process with full supervisor privileges`,
      hint: `only load code you trust: ${cfg.plugins.map((plugin) => plugin.path).join(", ")}`,
    });
  }
  for (const [name, recipe] of Object.entries(cfg.http)) {
    const url = recipe.request.url;
    // Only a literal (non-interpolated) URL can be scheme-checked here.
    if (url === "" || url.includes("${")) {
      continue;
    }
    if (!/^https:\/\//i.test(url.trim())) {
      checking(`http.${name} url scheme`);
      add({
        name: `http.${name} url scheme`,
        severity: "warn",
        message: "recipe url is not https",
        hint: "prefer https for a recipe that mints a token; http sends the minted credential in the clear",
      });
    }
  }
  for (const [name, recipe] of Object.entries(cfg.http)) {
    if (!recipe.expose.enabled) {
      continue;
    }
    const allowOrigin = Object.entries(recipe.expose.response_headers)
      .find(([key]) => key.toLowerCase() === "access-control-allow-origin")?.[1];
    if (allowOrigin?.trim() === "*") {
      checking(`http.${name} expose CORS`);
      add({
        name: `http.${name} expose CORS`,
        severity: "warn",
        message: "expose route sets Access-Control-Allow-Origin: *",
        hint: "a wildcard lets any web page read the cached recipe body; scope it to a specific loopback origin or drop it",
      });
    }
  }
  checking("Google CLI installed");
  if (await host.hasCommand("gcloud")) {
    add({ name: "Google CLI installed", severity: "ok", message: "gcloud found" });
  } else {
    add({
      name: "Google CLI installed",
      severity: needsCloudFeatures(cfg) ? "error" : "warn",
      message: "gcloud not installed",
      hint: "install the Google Cloud CLI from https://cloud.google.com/sdk/docs/install",
    });
  }
  checking("Google environment");
  const st = await host.detectGoogle(cfg.google.project_id);
  if (st.adcAvailable) {
    add({ name: "Google authentication available", severity: "ok", message: "Application Default Credentials found" });
  } else {
    add({
      name: "Google authentication available",
      severity: needsCloudFeatures(cfg) ? "error" : "warn",
      message: "ADC unavailable",
      hint: "run `gcloud auth application-default login`",
    });
  }
  if (st.projectID !== "") {
    add({ name: "Project configured", severity: "ok", message: `${st.projectID} (source: ${st.projectSource})` });
  } else {
    add({
      name: "Project configured",
      severity: needsCloudFeatures(cfg) ? "error" : "warn",
      message: "no Google project configured",
      hint: "set google.project_id in .devctl/config.yaml",
    });
  }
  // Static file inspect — not gated on ADC, audience, or live mint.
  addIapCredentialsFileChecks(cfg, add, checking);
  const probeCloud =
    needsCloudFeatures(cfg) ||
    Object.values(cfg.services).some((svc) => svc.capabilities.includes("google") || svc.identity.type !== "");
  if (probeCloud) {
    checking("Live Google access");
    let liveOpen = true;
    const liveAdd = (c: Check): void => {
      if (liveOpen) {
        add(c);
      }
    };
    try {
      await withTimeout(
        (async () => {
          await addLiveCloudChecks(cfg, liveAdd, host, st.userEmail);
          await addLiveApiChecks(cfg, liveAdd, host);
        })(),
        host.liveDeadlineMs ?? LIVE_SECTION_MS,
      );
    } catch (err) {
      liveAdd({
        name: "Live Google probes",
        severity: "warn",
        message: humanMessage(err),
        hint: "network or timeout — retry when online",
      });
    } finally {
      liveOpen = false;
    }
  }
  const hotspot = host.mintRateWarning?.();
  if (hotspot && hotspot.count >= TOKEN_MINT_WARN_COUNT) {
    checking("Google token mint rate");
    const audience = hotspot.audience === "" ? "no audience" : hotspot.audience;
    add({
      name: "Google token mint rate",
      severity: "warn",
      message: `${hotspot.count} mints in the last minute for ${hotspot.identity} (${audience})`,
      hint: "cached tokens are reused until they expire; slow token-endpoint polling if a service is looping GET /token",
    });
  }
  for (const tool of cfg.doctor.tools) {
    const cmd = tool.command || tool.name;
    checking(`${tool.name} installed`);
    if (await host.hasCommand(cmd)) {
      add({ name: `${tool.name} installed`, severity: "ok", message: `${cmd} found` });
    } else {
      add({
        name: `${tool.name} installed`,
        severity: "error",
        message: `${cmd} not found`,
        hint: `install ${tool.name} and ensure it is on PATH`,
      });
    }
  }
  checking("Repository configuration");
  if (runtime?.repositoryConfigError !== undefined) {
    if (runtime.repositoryConfigError === "") {
      add({ name: "Repository configuration", severity: "ok", message: "valid" });
    } else {
      add({ name: "Repository configuration", severity: "error", message: runtime.repositoryConfigError });
    }
  } else {
    try {
      const issues = validate(cfg);
      if (issues.length > 0) {
        add({ name: "Repository configuration", severity: "error", message: issues.join("; ") });
      } else {
        add({ name: "Repository configuration", severity: "ok", message: "valid" });
      }
    } catch (err) {
      add({ name: "Repository configuration", severity: "error", message: humanMessage(err) });
    }
  }
  const seenPorts: Record<number, string> = {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    for (const p of svc.ports) {
      if (p.auto) {
        continue;
      }
      const label = `Port ${p.value}`;
      checking(label);
      if (seenPorts[p.value]) {
        add({ name: label, severity: "error", message: `configured on both ${seenPorts[p.value]} and ${name}` });
      } else {
        seenPorts[p.value] = name;
        const owner = runtime?.services?.[name];
        const containerIsRunning = Boolean(svc.container && owner && ["STARTING", "RUNNING", "HEALTHY", "UNHEALTHY"].includes(owner.state ?? ""));
        const ownedByRunningService = Boolean(owner && (owner.pid > 0 || containerIsRunning) && Object.values(owner.ports).includes(p.value));
        if (ownedByRunningService) {
          add({ name: label, severity: "ok", message: `in use by running service ${name}` });
        } else if (await host.portAvailable(p.value)) {
          add({ name: label, severity: "ok", message: "available" });
        } else {
          add(await busyPortCheck(label, p.value, `services.${name}.ports`));
        }
      }
    }
  }
  if (cfg.proxy.listen.port > 0) {
    const label = `Port ${cfg.proxy.listen.port}`;
    checking(label);
    if (runtime?.proxyRunning) {
      add({ name: label, severity: "ok", message: "in use by the running proxy" });
    } else if (await host.portAvailable(cfg.proxy.listen.port)) {
      add({ name: label, severity: "ok", message: "proxy listen port available" });
    } else {
      add(await busyPortCheck(label, cfg.proxy.listen.port, "proxy.listen.port"));
    }
  }
  active = "Diagnostics complete";
  publish();
  return report;
}

async function addLiveApiChecks(cfg: DevctlConfig, add: (c: Check) => void, host: DoctorHost): Promise<void> {
  const project = cfg.google.project_id;
  const adc = host.hasLocalAdc ?? hasLocalAdcMaterial;
  if (project === "" || !adc()) {
    return;
  }
  const probe = host.probeServiceUsage ?? defaultHost.probeServiceUsage!;
  const apis = [
    { name: "IAM Credentials API", service: "iamcredentials.googleapis.com" },
    { name: "Resource Manager API", service: "cloudresourcemanager.googleapis.com" },
    { name: "IAP API", service: "iap.googleapis.com" },
  ];
  const results = await Promise.allSettled(apis.map((api) => withTimeout(probe(project, api.service), LIVE_PROBE_MS)));
  results.forEach((result, index) => {
    const api = apis[index];
    if (!api) {
      return;
    }
    if (result.status === "fulfilled") {
      add({
        name: api.name,
        severity: result.value ? "ok" : "warn",
        message: result.value ? "enabled" : "not enabled or unreachable",
        hint: result.value ? undefined : `enable ${api.service} in the Google Cloud console — doctor never auto-enables APIs`,
      });
      return;
    }
    add({
      name: api.name,
      severity: "warn",
      message: humanMessage(result.reason),
      hint: `enable ${api.service} in the Google Cloud console — doctor never auto-enables APIs`,
    });
  });
}

async function addLiveCloudChecks(
  cfg: DevctlConfig,
  add: (c: Check) => void,
  host: DoctorHost,
  sourcePrincipal: string,
): Promise<void> {
  const accounts = configuredServiceAccounts(cfg);
  const iapRoutes = cfg.proxy.routes.filter((route) => route.auth.type.toLowerCase() === "iap");
  const mintableIap = iapRoutes.filter((route) => route.auth.audience.trim() !== "");
  for (const route of iapRoutes) {
    if (route.auth.audience.trim() === "") {
      add({
        name: `IAP audience ${route.name}`,
        severity: "error",
        message: "missing audience",
        hint: "set auth.audience to the IAP OAuth client ID",
      });
    }
  }
  if (accounts.length === 0 && mintableIap.length === 0) {
    return;
  }
  const adc = host.hasLocalAdc ?? hasLocalAdcMaterial;
  if (!adc()) {
    return;
  }
  const mint = host.mintToken ?? defaultHost.mintToken!;
  const impersonation = accounts.map(async (email) => {
    try {
      await withTimeout(mint(`sa:${email}`, ""), LIVE_PROBE_MS);
      add({ name: `Impersonate ${email}`, severity: "ok", message: "token minted" });
    } catch (err) {
      const quotaProject = (host.adcQuotaProject ?? adcQuotaProject)();
      const principal = sourcePrincipal || "the ADC principal";
      const quota = quotaProject === "" ? "unknown" : quotaProject;
      const check = classifyLiveFailure(
        `Impersonate ${email}`,
        err,
        `grant roles/iam.serviceAccountTokenCreator to ${principal} on ${email}; ADC quota project: ${quota}`,
      );
      if (quotaProject !== "" && check.message.toLowerCase().includes("api is not enabled")) {
        check.message = `IAM Credentials API is disabled in ADC quota project ${quotaProject}`;
        check.hint = `enable iamcredentials.googleapis.com in ${quotaProject}, or set the ADC quota project to ${cfg.google.project_id}`;
      } else if (check.message.toLowerCase() === "google authentication failed") {
        check.message = `access-token mint failed: ${principal} → ${email}`;
        check.hint = `verify roles/iam.serviceAccountTokenCreator for ${principal} on this service account; ADC quota project: ${quota}`;
      }
      add(check);
    }
  });
  const iap = mintableIap.map(async (route) => {
    const identity = fromRoute(route.auth).kind === KindServiceAccount ? `sa:${fromRoute(route.auth).serviceAccount}` : "user";
    try {
      const oauth = iapOAuthClientRef(route.auth);
      await withTimeout(mint(identity, route.auth.audience, oauth), LIVE_PROBE_MS);
      add({ name: `IAP ${route.name}`, severity: "ok", message: "id token minted" });
    } catch (err) {
      add(classifyLiveFailure(`IAP ${route.name}`, err, "check IAP OAuth client ID and ADC"));
    }
  });
  await Promise.all([...impersonation, ...iap]);
}

function addIapCredentialsFileChecks(
  cfg: DevctlConfig,
  add: (c: Check) => void,
  checking: (name: string) => void,
): void {
  const proxyCredentials = cfg.proxy.credentials.trim();
  for (const route of cfg.proxy.routes) {
    if (route.auth.type.toLowerCase() !== "iap") {
      continue;
    }
    const path = iapCredentialsPath(route.auth, proxyCredentials);
    if (path === "" || envRefsIn(path).length > 0) {
      continue;
    }
    const name = `IAP credentials ${route.name}`;
    checking(name);
    add(iapCredentialsFileCheck(name, path, route.auth.client_id));
  }
}

// auth.credentials wins; proxy.credentials is the fold used at load time for
// custom-client IAP routes that omit their own file.
function iapCredentialsPath(auth: RouteAuthConfig, proxyCredentials: string): string {
  const own = (auth.credentials ?? "").trim();
  if (own !== "") {
    return own;
  }
  if (auth.client_id.trim() === "") {
    return "";
  }
  return proxyCredentials;
}

function iapCredentialsFileCheck(name: string, path: string, clientId: string): Check {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return iapCredentialsFailure(name, `file not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return iapCredentialsFailure(name, `file is not valid JSON: ${path}`);
  }
  const result = inspectIapOAuthClientFile(parsed, clientId);
  if (result.ok) {
    return { name, severity: "ok", message: "authorized_user file matches client_id" };
  }
  return iapCredentialsFailure(name, iapCredentialsIssueMessage(result.issue, path));
}

function iapCredentialsFailure(name: string, message: string): Check {
  return { name, severity: "error", message, hint: IAP_CREDENTIALS_LOGIN_HINT };
}

function iapCredentialsIssueMessage(issue: IapOAuthClientInspectIssue, path: string): string {
  switch (issue) {
    case "malformed":
      return `file is malformed: ${path}`;
    case "wrong_type":
      return "file type must be authorized_user";
    case "missing_refresh_token":
      return "file has no refresh_token";
    case "missing_client_id":
      return "file has no client_id";
    case "client_id_mismatch":
      return "file client_id does not match auth.client_id";
  }
}

function classifyLiveFailure(name: string, err: unknown, hint: string): Check {
  const message = humanMessage(err);
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("econnrefused") || lower.includes("enotfound")) {
    return { name, severity: "warn", message, hint: "network or timeout — retry when online" };
  }
  if (err instanceof DevctlError && err.hint !== "") {
    const prefix = `${err.kind}: `;
    const summary = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
    return { name, severity: "error", message: summary, hint: err.hint };
  }
  return { name, severity: "error", message, hint };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
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

async function busyPortCheck(label: string, port: number, configField: string): Promise<Check> {
  const holder = await findPortHolder(port);
  if (!holder) {
    return {
      name: label,
      severity: "error",
      message: "already in use",
      hint: `stop the process using port ${port} or change ${configField}`,
    };
  }
  if (holder.pid === process.pid) {
    return {
      name: label,
      severity: "error",
      message: `in use by this TUI (${holder.command} pid ${holder.pid})`,
      hint: "stop the proxy from the proxy screen (x), then rerun doctor",
    };
  }
  return {
    name: label,
    severity: "error",
    message: `in use by ${holder.command} (pid ${holder.pid})`,
    hint: "enter  stop that process after a confirmation",
    action: { kind: "free-port", holder },
  };
}

export function formatDoctor(r: Report): string {
  const lines = [`${versionLine()} doctor`, ""];
  for (const c of r.checks) {
    const mark = c.severity === "error" ? "✗" : c.severity === "warn" ? "!" : "✓";
    lines.push(`${mark} ${c.name}`);
    if (c.severity !== "ok") {
      lines.push(`    ${c.message}`);
      if (c.hint) {
        lines.push(`    → ${c.hint}`);
      }
    }
  }
  lines.push("", `${r.issues} issue(s) found.`);
  return lines.join("\n") + "\n";
}
