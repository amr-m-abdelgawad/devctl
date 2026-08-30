import "./gcp-env.ts";
import { spawn } from "bun";
import { type DevctlConfig, validate } from "./config/index.ts";
import { versionLine } from "./version.ts";
import { humanMessage } from "./errors.ts";
import { detectGoogle } from "./google.ts";
import { configuredServiceAccounts, fromRoute, KindServiceAccount, needsCloudFeatures } from "./identity.ts";
import { available, findPortHolder, type PortHolder } from "./ports.ts";

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

export async function runDoctor(cfg: DevctlConfig): Promise<Report> {
  const report: Report = { checks: [], issues: 0 };
  const add = (c: Check): void => {
    report.checks.push(c);
    if (c.severity === "error") {
      report.issues += 1;
    }
  };
  if (await hasCommand("gcloud")) {
    add({ name: "Google CLI installed", severity: "ok", message: "gcloud found" });
  } else {
    add({
      name: "Google CLI installed",
      severity: needsCloudFeatures(cfg) ? "error" : "warn",
      message: "gcloud not installed",
      hint: "install the Google Cloud CLI from https://cloud.google.com/sdk/docs/install",
    });
  }
  const st = await detectGoogle(cfg.google.project_id);
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
    await addLiveCloudChecks(cfg, add);
    await addLiveApiChecks(cfg, add);
  }
  for (const tool of cfg.doctor.tools) {
    const cmd = tool.command || tool.name;
    if (await hasCommand(cmd)) {
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
        if (await available(p.value)) {
          add({ name: label, severity: "ok", message: "available" });
        } else {
          add(await busyPortCheck(label, p.value, `services.${name}.ports`));
        }
      }
    }
  }
  if (cfg.proxy.listen.port > 0) {
    const label = `Port ${cfg.proxy.listen.port}`;
    if (await available(cfg.proxy.listen.port)) {
      add({ name: label, severity: "ok", message: "proxy listen port available" });
    } else {
      add(await busyPortCheck(label, cfg.proxy.listen.port, "proxy.listen.port"));
    }
  }
  return report;
}

async function addLiveApiChecks(cfg: DevctlConfig, add: (c: Check) => void): Promise<void> {
  const project = cfg.google.project_id;
  if (project === "") {
    return;
  }
  const apis = [
    { name: "IAM Credentials API", service: "iamcredentials.googleapis.com" },
    { name: "Resource Manager API", service: "cloudresourcemanager.googleapis.com" },
    { name: "IAP API", service: "iap.googleapis.com" },
  ];
  for (const api of apis) {
    try {
      const ok = await probeServiceUsage(project, api.service);
      add({
        name: api.name,
        severity: ok ? "ok" : "warn",
        message: ok ? "reachable" : "not enabled or unreachable",
        hint: ok ? undefined : `enable ${api.service} in the Google Cloud console — doctor never auto-enables APIs`,
      });
    } catch (err) {
      add({
        name: api.name,
        severity: "warn",
        message: humanMessage(err),
        hint: `enable ${api.service} in the Google Cloud console — doctor never auto-enables APIs`,
      });
    }
  }
}

async function loadTokenManager(thresholdMs: number) {
  const { TokenManager, googleTokenProviders } = await import("./token.ts");
  return new TokenManager(thresholdMs, googleTokenProviders());
}

async function probeServiceUsage(project: string, service: string): Promise<boolean> {
  const tokens = await loadTokenManager(60_000);
  const tok = await withTimeout(tokens.get("user", "", []), LIVE_PROBE_MS);
  const url = `https://serviceusage.googleapis.com/v1/projects/${project}/services/${service}`;
  const resp = await withTimeout(
    fetch(url, { headers: { Authorization: `Bearer ${tok.accessToken}` } }),
    LIVE_PROBE_MS,
  );
  return resp.ok;
}

async function addLiveCloudChecks(cfg: DevctlConfig, add: (c: Check) => void): Promise<void> {
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
  const tokens = await loadTokenManager(0);
  for (const email of accounts) {
    try {
      await withTimeout(tokens.get(`sa:${email}`, "", []), LIVE_PROBE_MS);
      add({ name: `Impersonate ${email}`, severity: "ok", message: "token minted" });
    } catch (err) {
      add(classifyLiveFailure(`Impersonate ${email}`, err, "grant roles/iam.serviceAccountTokenCreator on this service account"));
    }
  }
  for (const route of mintableIap) {
    try {
      await withTimeout(tokens.get(fromRoute(route.auth).kind === KindServiceAccount ? `sa:${fromRoute(route.auth).serviceAccount}` : "user", route.auth.audience, []), LIVE_PROBE_MS);
      add({ name: `IAP ${route.name}`, severity: "ok", message: "id token minted" });
    } catch (err) {
      add(classifyLiveFailure(`IAP ${route.name}`, err, "check IAP OAuth client ID and ADC"));
    }
  }
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

async function hasCommand(name: string): Promise<boolean> {
  const proc = spawn({ cmd: ["which", name], stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}
