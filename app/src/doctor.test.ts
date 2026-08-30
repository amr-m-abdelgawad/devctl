import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { runDoctor } from "./doctor.ts";

function localCfg() {
  const cfg = defaultConfig();
  cfg.services.api = {
    ...emptyService(),
    command: { args: ["true"], shell: false },
    ports: [{ name: "http", value: 19991, auto: false }],
  };
  return cfg;
}

describe("doctor", () => {
  test("skips live impersonation when the repo is local-only", async () => {
    const report = await runDoctor(localCfg());
    expect(report.checks.some((c) => c.name.startsWith("Impersonate "))).toBe(false);
    expect(report.checks.some((c) => c.name === "Repository configuration")).toBe(true);
  });

  test("flags missing IAP audience without minting a token", async () => {
    const cfg = localCfg();
    cfg.proxy.routes.push({
      name: "billing",
      match: { host: "billing.local", path: "" },
      upstream: { url: "https://example.com" },
      auth: { type: "iap", identity: { type: "user", service_account: "" }, audience: "", service_account: "" },
    });
    const report = await runDoctor(cfg);
    const aud = report.checks.find((c) => c.name === "IAP audience billing");
    expect(aud?.severity).toBe("error");
    expect(aud?.message).toContain("missing audience");
  });
});
