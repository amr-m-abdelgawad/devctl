import type { RouteAuthConfig } from "../../domain/config/types.ts";
import { interpolateEnvRefs, interpolateEnvRefsProtectingToken } from "../../domain/config/env-ref.ts";
import { fromRoute, tokenIdentityKey } from "../../domain/identity/identity.ts";
import { KindConfiguration, KindProxy, newError } from "../../shared/errors.ts";
import { envWithSecrets } from "../environment/environment.ts";
import { iapOAuthClientRef, type TokenManager } from "../google/token.ts";

export async function mintAuthToken(auth: RouteAuthConfig, tokens?: TokenManager, env: Record<string, string | undefined> = process.env, repoRoot?: string): Promise<string | undefined> {
  const authType = auth.type.toLowerCase();
  if (authType === "" || authType === "none") {
    return undefined;
  }
  if (!tokens) {
    throw newError(KindProxy, "token manager unavailable");
  }
  const ident = fromRoute(auth);
  const audience = requireEnvInterpolation(auth.audience, envWithSecrets(env, repoRoot), "auth.audience");
  const tok = await tokens.get(tokenIdentityKey(ident), audience, [], iapOAuthClientRef(auth, env, repoRoot));
  return tok.accessToken;
}

export function headerHasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

export function applyExtraAuthHeaders(
  headers: Record<string, string>,
  extra: Record<string, string> | undefined,
  token: string,
  env: Record<string, string | undefined> = envWithSecrets(process.env),
): void {
  for (const [key, value] of Object.entries(extra ?? {})) {
    const { value: interpolated, missing } = interpolateEnvRefsProtectingToken(value, env, token);
    if (missing.length > 0) {
      throw newError(KindConfiguration, `auth.headers env ${missing[0]} is empty`);
    }
    headers[key] = interpolated;
  }
}

export function requireEnvInterpolation(value: string, env: Record<string, string | undefined>, label: string): string {
  if (value === "" || !value.includes("${")) {
    return value;
  }
  const { value: interpolated, missing } = interpolateEnvRefs(value, env);
  if (missing.length > 0) {
    throw newError(KindConfiguration, `${label} env ${missing[0]} is empty`);
  }
  return interpolated;
}
