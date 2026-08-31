import "./gcp-env.ts";
import { type DevctlConfig, validate } from "./config/index.ts";
import { versionLine } from "./version.ts";
import { humanMessage } from "./errors.ts";
import { detectGoogle, hasCommand, hasLocalAdcMaterial, type GoogleStatus } from "./google.ts";
import { configuredServiceAccounts, fromRoute, KindServiceAccount, needsCloudFeatures } from "./identity.ts";
import { available, findPortHolder, type PortHolder } from "./ports.ts";
import { openCredentialStore } from "./credentials.ts";

export type Severity = "ok" | "warn" | "error";

export type PortAction = {
  kind: "free-port";
  holder: PortHolder;
};

export type Check = {
  name: string;
  severity: Severity;
  message: string;
  hint?: string;
  action?: PortAction;
};

export type Report = {
  checks: Check[];
  issues: number;
};

const LIVE_PROBE_MS = 4_000;
const LIVE_SECTION_MS = 8_000;

export type DoctorHost = {
  detectGoogle(project: string): Promise<GoogleStatus>;
  hasCommand(name: string): Promise<boolean>;
  portAvailable(port: number): Promise<boolean>;
  hasLocalAdc?: () => boolean;
  liveDeadlineMs?: number;
  mintToken?: (identity: string, audience: string) => Promise<void>;
  probeServiceUsage?: (project: string, service: string) => Promise<boolean>;
};

const defaultHost: DoctorHost = {
  detectGoogle,
  hasCommand,
  portAvailable: available,
  hasLocalAdc: hasLocalAdcMaterial,
  mintToken: defaultMintToken,
  probeServiceUsage: defaultProbeServiceUsage,
};

export async function runDoctor(cfg: DevctlConfig, host: DoctorHost = defaultHost): Promise<Report> {
  const report: Report = { checks: [], issues: 0 };
  const add = (c: Check): void => {
    report.checks.push(c);
    if (c.severity === "error") {
      report.issues += 1;
    }
  };
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
  const probeCloud =
    needsCloudFeatures(cfg) ||
    Object.values(cfg.services).some((svc) => svc.capabilities.includes("google") || svc.identity.type !== "");
  if (probeCloud) {
    let liveOpen = true;
    const liveAdd = (c: Check): void => {
      if (liveOpen) {
        add(c);
      }
    };
    try {
      await withTimeout(
        (async () => {
          await addLiveCloudChecks(cfg, liveAdd, host);
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
  for (const tool of cfg.doctor.tools) {
    const cmd = tool.command || tool.name;
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
  const seenPorts: Record<number, string> = {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    for (const p of svc.ports) {
      if (p.auto) {
        continue;
      }
      const label = `Port ${p.value}`;
      if (seenPorts[p.value]) {
        add({ name: label, severity: "error", message: `configured on both ${seenPorts[p.value]} and ${name}` });
      } else {
        seenPorts[p.value] = name;
        if (await host.portAvailable(p.value)) {
          add({ name: label, severity: "ok", message: "available" });
        } else {
          add(await busyPortCheck(label, p.value, `services.${name}.ports`));
        }
      }
    }
  }
  if (cfg.proxy.listen.port > 0) {
    const label = `Port ${cfg.proxy.listen.port}`;
    if (await host.portAvailable(cfg.proxy.listen.port)) {
      add({ name: label, severity: "ok", message: "proxy listen port available" });
    } else {
      add(await busyPortCheck(label, cfg.proxy.listen.port, "proxy.listen.port"));
    }
  }
  return report;
}

async function addLiveApiChecks(cfg: DevctlConfig, add: (c: Check) => void, host: DoctorHost): Promise<void> {
  const project = cfg.google.project_id;
  const adc = host.hasLocalAdc ?? hasLocalAdcMaterial;
  if (project === "" || !adc()) {
    return;
  }
  const probe = host.probeServiceUsage ?? defaultProbeServiceUsage;
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
        message: result.value ? "reachable" : "not enabled or unreachable",
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

let doctorTokens: Promise<import("./token.ts").TokenManager> | undefined;

async function doctorTokenManager() {
  if (!doctorTokens) {
    doctorTokens = import("./token.ts").then(
      ({ TokenManager, googleTokenProviders }) =>
        new TokenManager(60_000, googleTokenProviders(), undefined, openCredentialStore("file")),
    );
  }
  return doctorTokens;
}

async function defaultMintToken(identity: string, audience: string): Promise<void> {
  const tokens = await doctorTokenManager();
  await tokens.get(identity, audience, []);
}

async function defaultProbeServiceUsage(project: string, service: string): Promise<boolean> {
  const tokens = await doctorTokenManager();
  const tok = await withTimeout(tokens.get("user", "", []), LIVE_PROBE_MS);
  const url = `https://serviceusage.googleapis.com/v1/projects/${project}/services/${service}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${tok.accessToken}` },
    signal: AbortSignal.timeout(LIVE_PROBE_MS),
  });
  return resp.ok;
}

async function addLiveCloudChecks(cfg: DevctlConfig, add: (c: Check) => void, host: DoctorHost): Promise<void> {
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
  const mint = host.mintToken ?? defaultMintToken;
  const impersonation = accounts.map(async (email) => {
    try {
      await withTimeout(mint(`sa:${email}`, ""), LIVE_PROBE_MS);
      add({ name: `Impersonate ${email}`, severity: "ok", message: "token minted" });
    } catch (err) {
      add(classifyLiveFailure(`Impersonate ${email}`, err, "grant roles/iam.serviceAccountTokenCreator on this service account"));
    }
  });
  const iap = mintableIap.map(async (route) => {
    const identity = fromRoute(route.auth).kind === KindServiceAccount ? `sa:${fromRoute(route.auth).serviceAccount}` : "user";
    try {
      await withTimeout(mint(identity, route.auth.audience), LIVE_PROBE_MS);
      add({ name: `IAP ${route.name}`, severity: "ok", message: "id token minted" });
    } catch (err) {
      add(classifyLiveFailure(`IAP ${route.name}`, err, "check IAP OAuth client ID and ADC"));
    }
  });
  await Promise.all([...impersonation, ...iap]);
}

function classifyLiveFailure(name: string, err: unknown, hint: string): Check {
  const message = humanMessage(err);
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("econnrefused") || lower.includes("enotfound")) {
    return { name, severity: "warn", message, hint: "network or timeout — retry when online" };
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

