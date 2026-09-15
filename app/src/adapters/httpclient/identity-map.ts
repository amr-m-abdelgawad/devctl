import { emptyRouteAuth, identityKind, type IdentityConfig, type RouteAuthConfig } from "../../domain/config/types.ts";

export function identityToRouteAuth(ident: IdentityConfig | undefined): RouteAuthConfig {
  if (!ident) {
    return emptyRouteAuth();
  }
  const kind = identityKind(ident).toLowerCase();
  if (kind === "" || kind === "none") {
    return emptyRouteAuth();
  }
  if (kind === "service" || kind === "service_account") {
    return {
      ...emptyRouteAuth(),
      type: "service_account",
      identity: { type: "service_account", service_account: ident.service_account },
      service_account: ident.service_account,
    };
  }
  if (kind === "iap") {
    return { ...emptyRouteAuth(), type: "iap" };
  }
  return { ...emptyRouteAuth(), type: "user", identity: { type: "user", service_account: "" } };
}

export function routeAuthMints(auth: RouteAuthConfig): boolean {
  const type = auth.type.toLowerCase();
  return type !== "" && type !== "none";
}
