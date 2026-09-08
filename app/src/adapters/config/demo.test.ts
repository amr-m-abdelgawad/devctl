import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { configuredServiceAccounts, needsCloudFeatures } from "../../domain/identity/identity.ts";
import { load } from "./load.ts";

describe("demo-platform config", () => {
  // Service-account/project values are deliberately NOT pinned to a literal
  // string here: the README documents them as the one thing a developer is
  // expected to swap for a real project via a local, uncommitted edit (see
  // "one find-and-replace across this directory"), so this test must pass
  // equally against the checked-in placeholder and against that override —
  // only structure and the fixed demo audience are asserted.
  test("loads the shared example", () => {
    const root = resolve(import.meta.dir, "../../../../examples/demo-platform");
    const cfg = load(root, "");
    expect(cfg.project.name).toBe("demo-platform");
    expect(Object.keys(cfg.services).sort()).toEqual(["billing-console", "identity", "invoices-api", "invoices-worker", "postgres", "telemetry"]);
    expect(cfg.profiles.backend?.services).toContain("invoices-worker");
    expect(cfg.profiles.backend?.services).not.toContain("postgres");
    expect(cfg.profiles.data?.services).toEqual(["postgres"]);
    expect(cfg.services.postgres?.container?.image).toBe("postgres:16");
    expect(cfg.proxy.listen.port).toBe(18080);
    expect(cfg.proxy.token_endpoint.enabled).toBe(true);

    // Three routes at the same upstream (invoices-worker), one per
    // non-"none" auth pattern — see config.yaml's comments for why.
    const bySA = cfg.proxy.routes.find((route) => route.name === "invoices-worker-impersonation");
    expect(bySA?.auth.type).toBe("service_account");
    expect(bySA?.auth.audience).toBe("");
    expect(bySA?.auth.identity.type).toBe("service_account");
    const sa = bySA?.auth.identity.service_account ?? "";
    expect(sa).not.toBe("");

    const byIapUser = cfg.proxy.routes.find((route) => route.name === "invoices-worker-iap-user");
    expect(byIapUser?.auth.type).toBe("iap");
    expect(byIapUser?.auth.audience).toBe("https://invoices-worker.local");
    expect(byIapUser?.auth.identity).toEqual({ type: "user", service_account: "" });

    const iapRoute = cfg.proxy.routes.find((route) => route.name === "invoices-worker-api");
    expect(iapRoute?.auth.type).toBe("iap");
    expect(iapRoute?.auth.audience).toBe("https://invoices-worker.local");
    expect(iapRoute?.auth.identity.type).toBe("service_account");
    // Both service-account routes are documented as sharing one placeholder
    // account, and a developer's local substitution should preserve that.
    expect(iapRoute?.auth.identity.service_account).toBe(sa);

    expect(configuredServiceAccounts(cfg)).toEqual([sa]);
    expect(needsCloudFeatures(cfg)).toBe(true);
  });
});
