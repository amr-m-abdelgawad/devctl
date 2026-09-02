import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { configuredServiceAccounts, declaredServiceAccounts, identityBlockers, needsCloudFeatures } from "./identity.ts";

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

  test("ignores a route's identity when auth.type is none", () => {
    const cfg = defaultConfig();
    cfg.proxy.routes.push({
      name: "public",
      match: { host: "", path: "" },
      upstream: { url: "https://example.com" },
      auth: {
        type: "none",
        // Leftover from when this route required auth, or copied from a
        // template — must not leak into service-account bookkeeping now
        // that the route itself needs no auth at all, matching how the
        // proxy's own request handling already treats "none" (proxy.ts).
        identity: { type: "service_account", service_account: "stale-dev@example.com" },
        audience: "",
        service_account: "",
      },
    });
    expect(configuredServiceAccounts(cfg)).toEqual([]);
    expect(declaredServiceAccounts(cfg)).toEqual([{ email: "stale-dev@example.com", active: false }]);
    expect(needsCloudFeatures(cfg)).toBe(false);
  });

  test("an active declaration wins when the same account also appears on an unauthenticated route", () => {
    const cfg = defaultConfig();
    cfg.services.worker = {
      ...emptyService(),
      identity: { type: "service_account", mode: "", service_account: "shared@example.com" },
    };
    cfg.proxy.routes.push({
      name: "public",
      match: { host: "", path: "" },
      upstream: { url: "https://example.com" },
      auth: {
        type: "none",
        identity: { type: "service_account", service_account: "shared@example.com" },
        audience: "",
        service_account: "",
      },
    });
    expect(declaredServiceAccounts(cfg)).toEqual([{ email: "shared@example.com", active: true }]);
    expect(configuredServiceAccounts(cfg)).toEqual(["shared@example.com"]);
  });

  test("local-only config does not need cloud features", () => {
    const cfg = defaultConfig();
    cfg.services.api = { ...emptyService(), command: { args: ["true"], shell: false } };
    expect(needsCloudFeatures(cfg)).toBe(false);
    expect(configuredServiceAccounts(cfg)).toEqual([]);
  });

  test("identity preflight blocks cloud services without ADC and leaves local ones", () => {
    const cfg = defaultConfig();
    cfg.services.api = { ...emptyService(), command: { args: ["true"], shell: false } };
    cfg.services.worker = {
      ...emptyService(),
      command: { args: ["true"], shell: false },
      identity: { type: "service_account", mode: "", service_account: "worker-dev@example.com" },
    };
    expect(identityBlockers(cfg, ["api", "worker"], false)).toEqual([{ name: "worker", message: "ADC unavailable" }]);
    expect(identityBlockers(cfg, ["api", "worker"], true)).toEqual([]);
  });
});
