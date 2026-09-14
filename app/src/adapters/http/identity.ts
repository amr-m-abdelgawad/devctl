import type { RouteAuthConfig } from "../../domain/config/types.ts";
import { fromRoute, tokenIdentityKey } from "../../domain/identity/identity.ts";
import { KindProxy, newError } from "../../shared/errors.ts";
import { iapOAuthClientRef, type TokenManager } from "../google/token.ts";

export async function mintAuthToken(auth: RouteAuthConfig, tokens?: TokenManager): Promise<string | undefined> {
  const authType = auth.type.toLowerCase();
  if (authType === "" || authType === "none") {
    return undefined;
  }
  if (!tokens) {
    throw newError(KindProxy, "token manager unavailable");
  }
  const ident = fromRoute(auth);
  const tok = await tokens.get(tokenIdentityKey(ident), auth.audience, [], iapOAuthClientRef(auth));
  return tok.accessToken;
}

export function headerHasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

export function substituteToken(value: string, token: string): string {
  return value.includes("${token}") ? value.replaceAll("${token}", token) : value;
}

export function applyExtraAuthHeaders(headers: Record<string, string>, extra: Record<string, string> | undefined, token: string): void {
  for (const [key, value] of Object.entries(extra ?? {})) {
    headers[key] = substituteToken(value, token);
  }
}
