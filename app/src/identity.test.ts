import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { configuredServiceAccounts, needsCloudFeatures } from "./identity.ts";

describe("identity helpers", () => {
  test("collects service accounts from services and routes", () => {
    const cfg = defaultConfig();
    cfg.services.worker = {
      ...emptyService(),
      identity: { type: "service_account", mode: "", service_account: "worker-dev@example.com" },
    };
    cfg.proxy.routes.push({
      name: "api",
      match: { host: "", path: "" },
      upstream: { url: "https://example.com" },
      auth: {
        type: "iap",
        identity: { type: "service_account", service_account: "api-dev@example.com" },
        audience: "aud",
        service_account: "",
      },
    });
    expect(configuredServiceAccounts(cfg)).toEqual(["api-dev@example.com", "worker-dev@example.com"]);
    expect(needsCloudFeatures(cfg)).toBe(true);
  });

  test("local-only config does not need cloud features", () => {
    const cfg = defaultConfig();
    cfg.services.api = { ...emptyService(), command: { args: ["true"], shell: false } };
    expect(needsCloudFeatures(cfg)).toBe(false);
    expect(configuredServiceAccounts(cfg)).toEqual([]);
  });
});
