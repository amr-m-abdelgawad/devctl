import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { runDoctor, type DoctorHost } from "./doctor.ts";

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
});
