import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { runDoctor, type DoctorHost } from "./doctor.ts";
import { classifyGoogle } from "./google.ts";

function localCfg() {
  const cfg = defaultConfig();
  cfg.services.api = {
    ...emptyService(),
    command: { args: ["true"], shell: false },
    ports: [{ name: "http", value: 19991, auto: false }],
  };
  return cfg;
}

function offlineHost(): DoctorHost {
  return {
    detectGoogle: async () => ({
      gcloudInstalled: false,
      adcAvailable: false,
      userEmail: "",
      projectID: "",
      projectSource: "",
    }),
    hasCommand: async () => false,
    portAvailable: async () => true,
    hasLocalAdc: () => false,
    mintToken: async () => {
      throw new Error("offline");
    },
    probeServiceUsage: async () => false,
  };
}

describe("doctor", () => {
  test("skips live impersonation when the repo is local-only", async () => {
    const report = await runDoctor(localCfg(), offlineHost());
    expect(report.checks.some((c) => c.name.startsWith("Impersonate "))).toBe(false);
    expect(report.checks.some((c) => c.name === "Repository configuration")).toBe(true);
  });

  test("reports real check progress while diagnostics run", async () => {
    const updates: { active: string; completed: number }[] = [];
    const report = await runDoctor(localCfg(), offlineHost(), (progress) => {
      updates.push({ active: progress.active, completed: progress.checks.length });
    });
    expect(updates[0]?.active).toBe("Google CLI installed");
    expect(updates.some((update) => update.active === "Google environment")).toBe(true);
    expect(updates.some((update) => update.active === "Repository configuration")).toBe(true);
    expect(updates.at(-1)).toEqual({ active: "Diagnostics complete", completed: report.checks.length });
  });

  test("treats a configured port owned by its running service as healthy", async () => {
    const cfg = localCfg();
    const host = offlineHost();
    host.portAvailable = async () => false;
    const report = await runDoctor(cfg, host, undefined, {
      services: { api: { pid: 4242, ports: { http: 19991 } } },
    });
    expect(report.checks.find((check) => check.name === "Port 19991")).toEqual({
      name: "Port 19991",
      severity: "ok",
      message: "in use by running service api",
    });
  });

  test("keeps an occupied port as an error when its service is stopped", async () => {
    const cfg = localCfg();
    const host = offlineHost();
    host.portAvailable = async () => false;
    const report = await runDoctor(cfg, host, undefined, {
      services: { api: { pid: 0, ports: { http: 19991 } } },
    });
    expect(report.checks.find((check) => check.name === "Port 19991")?.severity).toBe("error");
  });

  test("flags missing IAP audience without minting a token", async () => {
    const cfg = localCfg();
    cfg.google.project_id = "demo";
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { type: "iap", identity: { type: "user", service_account: "" }, audience: "", service_account: "" },
    });
    const host = offlineHost();
    const report = await runDoctor(cfg, host);
    const aud = report.checks.find((c) => c.name === "IAP audience billing");
    expect(aud?.severity).toBe("error");
    expect(aud?.message).toContain("missing audience");
    expect(report.checks.some((c) => c.name.startsWith("IAP billing"))).toBe(false);
    expect(report.checks.some((c) => c.name === "IAM Credentials API")).toBe(false);
  });

  test("live ADC probes cannot stall doctor", async () => {
    const cfg = localCfg();
    cfg.google.project_id = "company-dev";
    cfg.services.api = {
      ...cfg.services.api!,
      identity: { type: "user", mode: "", service_account: "" },
    };
    const hang = (): Promise<boolean> => new Promise(() => {});
    const host: DoctorHost = {
      detectGoogle: async () => ({
        gcloudInstalled: true,
        adcAvailable: true,
        userEmail: "dev@example.com",
        projectID: "company-dev",
        projectSource: "configuration",
      }),
      hasCommand: async () => true,
      portAvailable: async () => true,
      hasLocalAdc: () => true,
      liveDeadlineMs: 50,
      mintToken: async () => {
        await hang();
      },
      probeServiceUsage: hang,
    };
    const started = Date.now();
    const report = await runDoctor(cfg, host);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.checks.some((c) => c.name === "Repository configuration")).toBe(true);
    expect(report.checks.some((c) => c.name === "Google authentication available" && c.severity === "ok")).toBe(true);
    expect(report.checks.some((c) => c.name === "Live Google probes" && c.severity === "warn")).toBe(true);
  });

  test("preserves the disabled API hint instead of suggesting an IAM role", async () => {
    const cfg = localCfg();
    cfg.services.api = {
      ...cfg.services.api!,
      identity: { type: "service_account", mode: "", service_account: "api@example.com" },
    };
    const host = offlineHost();
    host.hasLocalAdc = () => true;
    host.adcQuotaProject = () => "developer-quota";
    host.mintToken = async () => {
      throw classifyGoogle(new Error("Permission denied: IAM Credentials API has not been enabled"));
    };
    const report = await runDoctor(cfg, host);
    const check = report.checks.find((item) => item.name === "Impersonate api@example.com");
    expect(check?.message).toContain("disabled in ADC quota project developer-quota");
    expect(check?.hint).toContain("enable iamcredentials.googleapis.com in developer-quota");
    expect(check?.hint).not.toContain("TokenCreator");
  });

  test("an unclassified impersonation failure names the exact principals and quota project", async () => {
    const cfg = localCfg();
    cfg.services.api = {
      ...cfg.services.api!,
      identity: { type: "service_account", mode: "", service_account: "api@example.com" },
    };
    const host = offlineHost();
    host.detectGoogle = async () => ({
      gcloudInstalled: true,
      adcAvailable: true,
      userEmail: "developer@example.com",
      projectID: "demo",
      projectSource: "configuration",
    });
    host.hasLocalAdc = () => true;
    host.adcQuotaProject = () => "developer-quota";
    host.mintToken = async () => {
      throw new Error("Google authentication failed");
    };
    const report = await runDoctor(cfg, host);
    const check = report.checks.find((item) => item.name === "Impersonate api@example.com");
    expect(check?.message).toBe("access-token mint failed: developer@example.com → api@example.com");
    expect(check?.hint).toContain("roles/iam.serviceAccountTokenCreator for developer@example.com");
    expect(check?.hint).toContain("ADC quota project: developer-quota");
  });
});
