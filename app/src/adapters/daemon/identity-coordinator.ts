import type { DevctlConfig, ServiceConfig } from "../../domain/config/types.ts";
import {
  configuredServiceAccounts,
  fromConfig,
  resolveIdentity,
  tokenIdentityKey,
  type IdentityProvider,
} from "../../domain/identity/identity.ts";
import type { Clock } from "../../ports/clock.ts";
import type { LogStore } from "../../ports/log-store.ts";
import type { IdentitySnapshot, ServiceAccountStatus } from "../../domain/status.ts";
import { humanMessage } from "../../shared/errors.ts";
import {
  AuthenticationChanged,
  type Bus,
  TokenRefreshed,
  TokenRefreshFailed,
  newEvent,
} from "../../shared/events.ts";
import { detectIdentity, type GoogleStatus } from "../google/google.ts";
import type { TokenManager } from "../google/token.ts";
import { emptyIdentitySnapshot, serviceAccountSnapshot } from "./snapshot.ts";

const IDENTITY_PROBE_MS = 4_000;

export type CredentialEntry = {
  identity: string;
  audience: string;
  expires_at: string;
  valid: boolean;
};

export type IdentityCoordinatorDeps = {
  cfg: () => DevctlConfig;
  tokens: TokenManager;
  detectGoogle: (project: string) => Promise<GoogleStatus>;
  clock: Clock;
  bus: Bus;
  logs: LogStore;
  persistState: () => void;
  fail: (name: string, err: unknown) => Promise<void>;
  log: (service: string, level: string, message: string) => void;
  identityProviders: () => IdentityProvider[] | undefined;
};

export class IdentityCoordinator {
  private cache: IdentitySnapshot;
  private readonly accounts = new Map<string, ServiceAccountStatus>();
  private entries: CredentialEntry[] = [];
  private readonly deps: IdentityCoordinatorDeps;

  constructor(deps: IdentityCoordinatorDeps) {
    this.deps = deps;
    this.cache = emptyIdentitySnapshot(deps.cfg());
    this.deps.bus.subscribe((ev) => {
      const payload = ev.payload ?? {};
      const message =
        ev.type === TokenRefreshed
          ? `token refreshed identity=${String(payload.identity ?? "")}`
          : ev.type === TokenRefreshFailed
            ? `token refresh failed identity=${String(payload.identity ?? "")} audience=${String(payload.audience ?? "")}: ${String(payload.error ?? "")}`
            : `authentication changed user=${String(payload.user ?? "")}`;
      this.deps.logs.append({
        timestamp: this.deps.clock.isoNow(),
        service: "auth",
        source: "auth",
        level: ev.type === TokenRefreshFailed ? "WARN" : "INFO",
        message,
        pid: 0,
      });
      if (ev.type === TokenRefreshed || ev.type === TokenRefreshFailed) {
        // A proxied request or the token endpoint can mint a fresh token at
        // any time, entirely outside refreshIdentity()'s boot/reload/manual
        // schedule. Without this, the credential store already has the new
        // expiry but the Credentials/Auth screens keep showing whatever
        // refreshIdentity() last cached until the user explicitly refreshes.
        void this.syncCredentialEntries();
      }
    }, [TokenRefreshed, TokenRefreshFailed, AuthenticationChanged]);
  }

  get identityCache(): IdentitySnapshot {
    return this.cache;
  }

  get serviceAccountStatus(): Map<string, ServiceAccountStatus> {
    return this.accounts;
  }

  get credentialEntries(): CredentialEntry[] {
    return this.entries;
  }

  async prepareServiceIdentity(name: string, svc: ServiceConfig): Promise<void> {
    let ident = fromConfig(svc.identity);
    if (ident.kind !== "none") {
      try {
        ident = await resolveIdentity(svc.identity, () => detectIdentity(this.deps.cfg().google.project_id), this.deps.identityProviders());
        if (ident.kind === "service_account") {
          await this.deps.tokens.get(tokenIdentityKey(ident), "", []);
          // First real use of this identity — cache the result so status
          // reflects it without waiting for an explicit refresh or doctor
          // inspection to get around to probing it.
          this.accounts.set(ident.serviceAccount, "available");
        }
      } catch (err) {
        if (ident.kind === "service_account") {
          this.accounts.set(ident.serviceAccount, "unavailable");
        }
        if (requiresCloudCapability(svc) || ident.kind === "service_account" || (ident.kind !== "user" && ident.kind !== "none")) {
          await this.deps.fail(name, err);
          throw err;
        }
        this.deps.log(name, "WARN", "cloud identity unavailable; starting service locally");
      }
    }
  }

  // Cheap local read of the credential store (keychain/file) — reflects
  // whatever TokenManager already minted and cached, never triggers a new
  // network fetch itself. Safe to call every time a token actually
  // refreshes, not just on the boot/reload/manual-refresh schedule below.
  async syncCredentialEntries(): Promise<void> {
    this.entries = (await this.deps.tokens.listStatus()).map((entry) => ({
      identity: entry.identity,
      audience: entry.audience,
      expires_at: entry.expires_at,
      valid: entry.valid,
    }));
  }

  // Automatic refresh (boot, after every reload) only ever updates ADC,
  // user, and project metadata — cheap, local checks. Probing every
  // configured service account is comparatively expensive (a real token
  // fetch per identity, each with its own timeout) and only happens when
  // opts.probeServiceAccounts is explicitly set: an "auth_refresh" request
  // or a doctor inspection, never an automatic pass. A service starting
  // under a service-account identity for the first time also updates the
  // cache for that one identity — see startOne.
  async refreshIdentity(opts?: { probeServiceAccounts?: boolean }): Promise<void> {
    try {
      const cfg = this.deps.cfg();
      const st = await this.deps.detectGoogle(cfg.google.project_id);
      if (opts?.probeServiceAccounts) {
        for (const email of configuredServiceAccounts(cfg)) {
          await this.probeServiceAccount(email);
        }
      }
      const { service_accounts, service_account_status } = serviceAccountSnapshot(cfg, this.accounts);
      this.cache = {
        user: st.userEmail,
        project: st.projectID || cfg.google.project_id,
        project_source: st.projectSource || (cfg.google.project_id ? "configuration" : ""),
        adc: st.adcAvailable,
        service_accounts,
        service_account_status,
        iap: cfg.proxy.routes.some((route) => route.auth.type.toLowerCase() === "iap"),
      };
      await this.syncCredentialEntries();
      this.deps.bus.publish(newEvent(AuthenticationChanged, "", { user: this.cache.user, adc: this.cache.adc }));
      this.deps.log("auth", "INFO", `authentication changed user=${this.cache.user || "(unknown)"} adc=${this.cache.adc}`);
      this.deps.persistState();
    } catch (err) {
      this.deps.log("devctl", "WARN", `identity refresh failed: ${humanMessage(err)}`);
    }
  }

  // Always mints fresh (never serves a cached-still-valid token) — this is
  // an explicit "confirm impersonation actually works right now" check
  // (auth_refresh or doctor), not a routine fetch, so a token that's merely
  // unexpired isn't good enough evidence. tokens.refresh() achieves that by
  // overwriting just this one cache entry; the caller must never reach for
  // tokens.invalidate() to force the same thing — that clears every
  // credential in the store, including ones this probe never touches.
  async probeServiceAccount(email: string): Promise<ServiceAccountStatus> {
    let status: ServiceAccountStatus;
    try {
      await withTimeout(this.deps.tokens.refresh(`sa:${email}`, "", []), IDENTITY_PROBE_MS);
      status = "available";
    } catch {
      status = "unavailable";
    }
    this.accounts.set(email, status);
    return status;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("identity probe timed out")), ms);
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

function requiresCloudCapability(svc: ServiceConfig): boolean {
  return svc.capabilities.some((c) => ["google_api", "iap", "service_identity"].includes(c));
}
