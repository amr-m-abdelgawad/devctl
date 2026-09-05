import {
  type DevctlConfig,
  type IdentityConfig,
  type RouteAuthConfig,
  isServiceAccountIdentity,
  isUserIdentity,
} from "../config/types.ts";
import { KindImpersonation, newError } from "../../shared/errors.ts";

export const KindUser = "user";
export const KindServiceAccount = "service_account";
export const KindNone = "none";

export type IdentityKind = string;

export type Identity = {
  kind: IdentityKind;
  email: string;
  serviceAccount: string;
  project: string;
  projectSource: string;
  adcAvailable: boolean;
  providerConfig: Record<string, unknown>;
  tokenKey: string;
};

export function fromConfig(cfg: IdentityConfig): Identity {
  if (isServiceAccountIdentity(cfg)) {
    return emptyIdentity({ kind: KindServiceAccount, serviceAccount: cfg.service_account });
  }
  if (isUserIdentity(cfg) && (cfg.type !== "" || cfg.mode !== "")) {
    return emptyIdentity({ kind: KindUser });
  }
  const kind = (cfg.type || cfg.mode).toLowerCase();
  if (kind !== "") return emptyIdentity({ kind, providerConfig: cfg.config ?? {} });
  return emptyIdentity({ kind: KindNone });
}

export function fromRoute(auth: RouteAuthConfig): Identity {
  // auth.type: "none" means the route needs no auth at all — any leftover
  // identity (from a template, or a route that used to require auth) must
  // not leak into service-account bookkeeping or preflight checks, matching
  // how the proxy's own request handling already treats "none" (proxy.ts).
  if (auth.type.toLowerCase() === "none") {
    return emptyIdentity({ kind: KindNone });
  }
  const t = auth.identity.type.toLowerCase();
  const sa = auth.identity.service_account || auth.service_account;
  if (t === "service" || t === "service_account" || auth.type === "service_account") {
    return emptyIdentity({ kind: KindServiceAccount, serviceAccount: sa });
  }
  if (auth.type.toLowerCase() === "iap" && t === "") {
    return emptyIdentity({ kind: KindNone });
  }
  if (auth.type === "" && t === "") {
    return emptyIdentity({ kind: KindNone });
  }
  return emptyIdentity({ kind: KindUser });
}

export function requiresCloud(ident: Identity): boolean {
  return ident.kind === KindUser || ident.kind === KindServiceAccount;
}

export function tokenIdentityKey(ident: Identity): string {
  if (ident.tokenKey !== "") return ident.tokenKey;
  if (ident.kind === KindServiceAccount) {
    return `sa:${ident.serviceAccount}`;
  }
  if (ident.email !== "") {
    return `user:${ident.email}`;
  }
  return "user";
}

export function emptyIdentity(partial: Partial<Identity> = {}): Identity {
  return {
    kind: KindNone,
    email: "",
    serviceAccount: "",
    project: "",
    projectSource: "",
    adcAvailable: false,
    providerConfig: {},
    tokenKey: "",
    ...partial,
  };
}

export type DeclaredServiceAccount = {
  email: string;
  // False means the address is present in configuration but cannot be used
  // by the declaration that contains it (currently, a route with auth:none).
  // Keeping that distinction lets the UI explain what it found without
  // turning a stale/inactive declaration into a probe or startup requirement.
  active: boolean;
};

export function declaredServiceAccounts(cfg: DevctlConfig): DeclaredServiceAccount[] {
  const found = new Map<string, boolean>();
  const add = (email: string, active: boolean): void => {
    if (email !== "") {
      found.set(email, (found.get(email) ?? false) || active);
    }
  };
  for (const svc of Object.values(cfg.services)) {
    if (isServiceAccountIdentity(svc.identity) && svc.identity.service_account !== "") {
      add(svc.identity.service_account, true);
    }
  }
  for (const route of cfg.proxy.routes) {
    const authType = route.auth.type.toLowerCase();
    const identityType = route.auth.identity.type.toLowerCase();
    const serviceAccount = route.auth.identity.service_account || route.auth.service_account;
    const declaresServiceAccount =
      identityType === "service" || identityType === "service_account" || authType === "service_account";
    if (declaresServiceAccount) {
      add(serviceAccount, authType !== "none");
    }
  }
  return [...found.entries()]
    .map(([email, active]) => ({ email, active }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

export function configuredServiceAccounts(cfg: DevctlConfig): string[] {
  return declaredServiceAccounts(cfg)
    .filter((account) => account.active)
    .map((account) => account.email);
}

export type IdentityBlocker = {
  name: string;
  message: string;
};

export function identityBlockers(
  cfg: DevctlConfig,
  names: string[],
  adcAvailable: boolean,
): IdentityBlocker[] {
  const out: IdentityBlocker[] = [];
  for (const name of names) {
    const svc = cfg.services[name];
    if (!svc) {
      continue;
    }
    const ident = fromConfig(svc.identity);
    if (isServiceAccountIdentity(svc.identity) && svc.identity.service_account === "") {
      out.push({ name, message: "service account identity is not configured" });
      continue;
    }
    const needsCloud =
      requiresCloud(ident) || svc.capabilities.some((cap) => cap === "google_api" || cap === "iap" || cap === "service_identity");
    if (needsCloud && !adcAvailable) {
      out.push({ name, message: "ADC unavailable" });
    }
  }
  return out;
}

export function needsCloudFeatures(cfg: DevctlConfig): boolean {
  if (configuredServiceAccounts(cfg).length > 0) {
    return true;
  }
  if (cfg.proxy.routes.some((route) => route.auth.type.toLowerCase() === "iap")) {
    return true;
  }
  return Object.values(cfg.services).some((svc) => {
    if (requiresCloud(fromConfig(svc.identity))) {
      return true;
    }
    return svc.capabilities.some((cap) => cap === "google_api" || cap === "iap" || cap === "service_identity");
  });
}

export type IdentityProvider = {
  name: string;
  accepts: (cfg: IdentityConfig) => boolean;
  resolve: (cfg: IdentityConfig, detect: () => Promise<Identity>) => Promise<Identity>;
};

export function userIdentityProvider(): IdentityProvider {
  return {
    name: "user",
    accepts: (cfg) => !isServiceAccountIdentity(cfg),
    resolve: async (cfg, detect) => {
      if (cfg.type === "" && cfg.mode === "") {
        return emptyIdentity({ kind: KindNone });
      }
      const user = await detect();
      return { ...user, kind: KindUser };
    },
  };
}

export function serviceAccountIdentityProvider(): IdentityProvider {
  return {
    name: "service_account",
    accepts: (cfg) => isServiceAccountIdentity(cfg),
    resolve: async (cfg, detect) => {
      if (cfg.service_account === "") {
        throw newError(KindImpersonation, "service account identity is not configured");
      }
      const base = await detect();
      return {
        ...base,
        kind: KindServiceAccount,
        serviceAccount: cfg.service_account,
      };
    },
  };
}

export async function resolveIdentity(
  cfg: IdentityConfig,
  detect: () => Promise<Identity>,
  providers?: IdentityProvider[],
): Promise<Identity> {
  // Registered providers include the builtins (pushed first by
  // registerBuiltins()) followed by any plugin-supplied providers, so
  // iterating in reverse gives plugins first refusal without needing to
  // special-case them.
  if (providers) {
    for (let i = providers.length - 1; i >= 0; i -= 1) {
      const provider = providers[i];
      if (provider?.accepts(cfg)) {
        return provider.resolve(cfg, detect);
      }
    }
  }
  if (isServiceAccountIdentity(cfg)) {
    return serviceAccountIdentityProvider().resolve(cfg, detect);
  }
  return userIdentityProvider().resolve(cfg, detect);
}
