import { emptyIdentity, PLUGIN_SDK_VERSION, type AccessToken, type IdentityProvider, type TokenProvider } from "../../app/src/plugin-sdk.ts";

type OidcConfig = { issuer: string; client_id: string; client_secret?: string; client_secret_env?: string; token_endpoint?: string; scopes?: string[] | string; audience?: string };
const configurations = new Map<string, OidcConfig>();

export const sdkVersion = PLUGIN_SDK_VERSION;

export const identityProviders: IdentityProvider[] = [{
  name: "oidc",
  accepts: (cfg) => (cfg.type || cfg.mode).toLowerCase() === "oidc",
  resolve: async (cfg) => {
    const config = cfg.config as OidcConfig | undefined;
    if (!config?.issuer || !config.client_id) throw new Error("oidc identity requires config.issuer and config.client_id");
    const tokenKey = `oidc:${config.client_id}@${config.issuer.replace(/\/$/, "")}`;
    configurations.set(tokenKey, config);
    return emptyIdentity({ kind: "oidc", tokenKey, providerConfig: config });
  },
}];

export const tokenProviders: TokenProvider[] = [{
  name: "oidc",
  accepts: (identity) => identity.startsWith("oidc:"),
  fetch: async (identity, audience, requestedScopes): Promise<AccessToken> => {
    const config = configurations.get(identity);
    if (!config) throw new Error(`OIDC identity ${identity} has not been resolved`);
    const secret = config.client_secret ?? (config.client_secret_env ? process.env[config.client_secret_env] : undefined);
    if (!secret) throw new Error("oidc identity requires config.client_secret or a populated config.client_secret_env");
    const endpoint = config.token_endpoint || await discoverTokenEndpoint(config.issuer);
    const configuredScopes = Array.isArray(config.scopes) ? config.scopes : typeof config.scopes === "string" ? config.scopes.split(/\s+/).filter(Boolean) : [];
    const scopes = requestedScopes.length > 0 ? requestedScopes : configuredScopes;
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: config.client_id, client_secret: secret });
    if (scopes.length > 0) form.set("scope", scopes.join(" "));
    const targetAudience = audience || config.audience || "";
    if (targetAudience) form.set("audience", targetAudience);
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    if (!response.ok) throw new Error(`OIDC token endpoint returned HTTP ${response.status}`);
    const body = await response.json() as { access_token?: string; token_type?: string; expires_in?: number };
    if (!body.access_token) throw new Error("OIDC token endpoint returned no access_token");
    return { accessToken: body.access_token, tokenType: body.token_type || "Bearer", expiresAt: new Date(Date.now() + Math.max(1, body.expires_in ?? 3600) * 1000), audience: targetAudience, identity, scopes };
  },
}];

async function discoverTokenEndpoint(issuer: string): Promise<string> {
  const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);
  const body = await response.json() as { token_endpoint?: string };
  if (!body.token_endpoint) throw new Error("OIDC discovery returned no token_endpoint");
  return body.token_endpoint;
}
