import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../../domain/config/types.ts";
import type { LogStore } from "../../ports/log-store.ts";
import { Bus } from "../../shared/events.ts";
import { TokenManager, type AccessToken, type TokenProvider } from "../google/token.ts";
import { IdentityCoordinator } from "./identity-coordinator.ts";

function tmp(): string {
  const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-ident-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = dir;
  return dir;
}

function token(partial: Partial<AccessToken> = {}): AccessToken {
  return {
    accessToken: "tok",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 60_000),
    audience: "",
    identity: "sa:worker-dev@example.com",
    scopes: [],
    ...partial,
  };
}

function coordinator() {
  const dir = tmp();
  const cfg = defaultConfig();
  cfg.repoRoot = dir;
  cfg.google.project_id = "company-dev";
  cfg.services.worker = {
    ...emptyService(),
    identity: { type: "service_account", mode: "", service_account: "worker-dev@example.com" },
  };
  const bus = new Bus(64);
  const logs = { append: () => undefined } as unknown as LogStore;
  const provider: TokenProvider = {
    name: "stub",
    fetch: async (identity) => {
      if (!identity.startsWith("sa:")) {
        throw new Error("not sa");
      }
      return token();
    },
  };
  const tokens = new TokenManager(60_000, [provider], bus);
  const identity = new IdentityCoordinator({
    cfg: () => cfg,
    tokens,
    detectGoogle: async () => ({
      gcloudInstalled: true,
      adcAvailable: true,
      userEmail: "dev@example.com",
      projectID: "company-dev",
      projectSource: "configuration",
    }),
    clock: { now: () => new Date(), isoNow: () => "2020-01-01T00:00:00Z", unixMs: () => 0 },
    bus,
    logs,
    persistState: () => undefined,
    fail: async () => undefined,
    log: () => undefined,
    identityProviders: () => undefined,
  });
  return { identity, tokens };
}

describe("identity coordinator", () => {
  test("automatic refresh updates ADC/user and leaves service accounts unknown", async () => {
    const { identity } = coordinator();
    await identity.refreshIdentity();
    expect(identity.identityCache.user).toBe("dev@example.com");
    expect(identity.identityCache.adc).toBe(true);
    expect(identity.identityCache.service_account_status["worker-dev@example.com"]).toBe("unknown");
    expect(identity.identityCache.service_accounts["worker-dev@example.com"]).toBeUndefined();
  });

  test("explicit probe marks a service account available", async () => {
    const { identity } = coordinator();
    await identity.refreshIdentity({ probeServiceAccounts: true });
    expect(identity.identityCache.service_account_status["worker-dev@example.com"]).toBe("available");
    expect(identity.identityCache.service_accounts["worker-dev@example.com"]).toBe(true);
  });

  test("TokenRefreshed outside refreshIdentity still syncs credential entries", async () => {
    const { identity, tokens } = coordinator();
    await identity.refreshIdentity();
    expect(identity.credentialEntries).toEqual([]);
    await tokens.get("sa:worker-dev@example.com", "", []);
    const deadline = Date.now() + 2000;
    while (identity.credentialEntries.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(identity.credentialEntries).toHaveLength(1);
    expect(identity.credentialEntries[0]?.identity).toBe("sa:worker-dev@example.com");
    expect(identity.credentialEntries[0]?.valid).toBe(true);
  });
});
