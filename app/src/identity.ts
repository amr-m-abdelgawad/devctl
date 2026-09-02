import {
  type DevctlConfig,
  type IdentityConfig,
  type RouteAuthConfig,
  isServiceAccountIdentity,
  isUserIdentity,
} from "./config/index.ts";
import { KindImpersonation, newError } from "./errors.ts";

export const KindUser = "user";
export const KindServiceAccount = "service_account";
export const KindNone = "none";

export type IdentityKind = typeof KindUser | typeof KindServiceAccount | typeof KindNone;

export type Identity = {
  kind: IdentityKind;
  email: string;
  serviceAccount: string;
  project: string;
  projectSource: string;
  adcAvailable: boolean;
};

export function fromConfig(cfg: IdentityConfig): Identity {
  if (isServiceAccountIdentity(cfg)) {
    return emptyIdentity({ kind: KindServiceAccount, serviceAccount: cfg.service_account });
  }
  if (isUserIdentity(cfg) && (cfg.type !== "" || cfg.mode !== "")) {
    return emptyIdentity({ kind: KindUser });
  }
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
    ...partial,
  };
}

export function configuredServiceAccounts(cfg: DevctlConfig): string[] {
  const found = new Set<string>();
  for (const svc of Object.values(cfg.services)) {
    if (isServiceAccountIdentity(svc.identity) && svc.identity.service_account !== "") {
      found.add(svc.identity.service_account);
    }
  }
  for (const route of cfg.proxy.routes) {
    const ident = fromRoute(route.auth);
    if (ident.kind === KindServiceAccount && ident.serviceAccount !== "") {
      found.add(ident.serviceAccount);
    }
  }
  return [...found].sort();
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
