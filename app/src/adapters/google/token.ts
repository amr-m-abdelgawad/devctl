import "./gcp-env.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleAuth, Impersonated, UserRefreshClient } from "google-auth-library";
import { type CredentialRecord, type CredentialStatus, type CredentialStore, openCredentialStore } from "../storage/credentials.ts";
import { DevctlError, hintError, humanMessage, KindAuthentication, KindAuthorization, KindConfiguration, KindToken, newError } from "../../shared/errors.ts";
import { type Bus, TokenRefreshed, TokenRefreshFailed, newEvent } from "../../shared/events.ts";
import { classifyGoogle, ensureFetchShim } from "./google.ts";
import { withRetry } from "../../shared/retry.ts";
import { credentialsDir, writeFileSecure } from "../storage/storage.ts";
import type { Clock } from "../../ports/clock.ts";
import type { OAuthClientCredentials } from "../../ports/credential-provider.ts";
import { systemClock } from "../system/clock.ts";
import type { RouteAuthConfig } from "../../domain/config/types.ts";
import { interpolateEnvRefs } from "../../domain/config/env-ref.ts";

const DEFAULT_THRESHOLD_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 50 * 60 * 1000;
const TOKEN_RETRY_MAX = 3;
const TOKEN_RETRY_BACKOFF_MS = 200;
const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const IAP_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

export type AccessToken = {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
  audience: string;
  identity: string;
  scopes: string[];
};

export type { OAuthClientCredentials } from "../../ports/credential-provider.ts";

export type TokenProvider = {
  name: string;
  accepts?: (identity: string, audience: string, scopes: string[], oauth?: OAuthClientCredentials) => boolean;
  fetch: (identity: string, audience: string, scopes: string[], oauth?: OAuthClientCredentials) => Promise<AccessToken>;
};

export type TokenMeta = {
  identity: string;
  audience: string;
  expires_at: string;
  scopes: string[];
};

export function tokenCacheKey(identity: string, audience: string, scopes: string[], clientId?: string): string {
  const id = clientId ?? "";
  const base = `${identity}|${audience}|${scopes.join(",")}`;
  return id === "" ? base : `${base}|oauth:${id}`;
}

type AuthorizedUserFile = { clientId: string; clientSecret: string; refreshToken: string };

// Load a gcloud authorized_user JSON (the same shape as ADC): client_id,
// client_secret, refresh_token. Only refresh_token is required; the client
// fields fall back to the route's when absent.
function loadAuthorizedUserFile(path: string): AuthorizedUserFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw newError(KindConfiguration, `IAP credentials file not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw newError(KindConfiguration, `IAP credentials file is not valid JSON: ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw newError(KindConfiguration, `IAP credentials file is malformed: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  const refreshToken = typeof obj.refresh_token === "string" ? obj.refresh_token : "";
  if (refreshToken === "") {
    throw newError(KindConfiguration, `IAP credentials file has no refresh_token: ${path}`);
  }
  // A refresh token is only meaningful with its issuing client, so require the
  // client_id — that lets resolveIapOAuthClient reject a file that belongs to a
  // different client before it mints (and 502s with an opaque Google error).
  const clientId = typeof obj.client_id === "string" ? obj.client_id : "";
  if (clientId === "") {
    throw newError(KindConfiguration, `IAP credentials file has no client_id: ${path}`);
  }
  return {
    clientId,
    clientSecret: typeof obj.client_secret === "string" ? obj.client_secret : "",
    refreshToken,
  };
}

export function resolveIapOAuthClient(auth: RouteAuthConfig, env: NodeJS.ProcessEnv = process.env): OAuthClientCredentials | undefined {
  const clientId = (auth.client_id ?? "").trim();
  if (clientId === "") {
    return undefined;
  }
  const raw = (auth.client_secret ?? "").trim();
  const { value: envSecret, missing } = interpolateEnvRefs(raw, env);

  const credPath = (auth.credentials ?? "").trim();
  if (credPath !== "") {
    // A separate authorized_user file supplies the refresh token (and, when the
    // route omits them, the client id/secret). ADC is never consulted, so the
    // default gcloud client stays usable for GCS/Firestore.
    const file = loadAuthorizedUserFile(credPath);
    if (file.clientId !== clientId) {
      throw newError(KindConfiguration, `IAP credentials file ${credPath} is for client_id ${file.clientId}, not the route's ${clientId}`);
    }
    const clientSecret = envSecret !== "" ? envSecret : file.clientSecret;
    if (clientSecret === "") {
      throw newError(KindConfiguration, `IAP client_id ${clientId} requires a client_secret (in the route or ${credPath})`);
    }
    return { clientId, clientSecret, refreshToken: file.refreshToken };
  }

  if (envSecret === "") {
    const name = missing[0];
    throw newError(KindConfiguration, name ? `IAP client_secret env ${name} is empty` : `IAP client_id ${clientId} requires client_secret`);
  }
  return { clientId, clientSecret: envSecret };
}

// A lazy handle to a route's OAuth client. The token cache key needs only the
// clientId, so `get`/`refresh` can find a valid cached token without touching
// the (possibly env-backed, possibly empty) secret — resolve() runs, and can
// throw, only when a refresh actually mints a new token. This keeps a still
// valid cached token usable even after its env secret is removed, instead of
// 502-ing on the eager resolve.
export type OAuthClientRef = {
  clientId: string;
  resolve: () => OAuthClientCredentials;
};

export function iapOAuthClientRef(auth: RouteAuthConfig, env: NodeJS.ProcessEnv = process.env): OAuthClientRef | undefined {
  const clientId = (auth.client_id ?? "").trim();
  if (clientId === "") {
    return undefined;
  }
  return {
    clientId,
    resolve: () => {
      const creds = resolveIapOAuthClient(auth, env);
      if (!creds) {
        throw newError(KindConfiguration, `IAP client_id ${clientId} requires client_secret`);
      }
      return creds;
    },
  };
}

export function isValidToken(tok: AccessToken, thresholdMs = DEFAULT_THRESHOLD_MS, nowMs = Date.now()): boolean {
  if (tok.accessToken === "") {
    return false;
  }
  return tok.expiresAt.getTime() - nowMs >= thresholdMs;
}

export function expiresSoonToken(tok: AccessToken, thresholdMs = DEFAULT_THRESHOLD_MS, nowMs = Date.now()): boolean {
  if (tok.accessToken === "") {
    return true;
  }
  const remaining = tok.expiresAt.getTime() - nowMs;
  return remaining > 0 && remaining < thresholdMs;
}

export class TokenManager {
  private readonly cache = new Map<string, AccessToken>();
  private readonly inflight = new Map<string, Promise<AccessToken>>();
  private readonly providers: TokenProvider[];
  private readonly thresholdMs: number;
  private readonly bus?: Bus;
  private readonly store: CredentialStore;
  private readonly clock: Clock;

  constructor(thresholdMs: number, providers: TokenProvider[], bus?: Bus, store?: CredentialStore, clock: Clock = systemClock) {
    this.thresholdMs = thresholdMs > 0 ? thresholdMs : DEFAULT_THRESHOLD_MS;
    this.providers = [...providers];
    this.bus = bus;
    this.store = store ?? openCredentialStore(process.env.DEVCTL_CREDENTIAL_BACKEND === "file" ? "file" : undefined);
    this.clock = clock;
  }

  replaceProviders(providers: TokenProvider[]): void {
    this.providers.splice(0, this.providers.length, ...providers);
  }

  isValid(tok: AccessToken): boolean {
    return isValidToken(tok, this.thresholdMs, this.clock.unixMs());
  }

  expiresSoon(tok: AccessToken): boolean {
    return expiresSoonToken(tok, this.thresholdMs, this.clock.unixMs());
  }

  invalidate(key?: string): void {
    if (key === undefined || key === "") {
      this.cache.clear();
      void this.clearStore();
      return;
    }
    this.cache.delete(key);
    void this.store.delete(key);
  }

  async listStatus(): Promise<CredentialStatus[]> {
    return this.store.list();
  }

  storeBackend(): string {
    return this.store.backend;
  }

  async get(identity: string, audience: string, scopes: string[], oauth?: OAuthClientRef): Promise<AccessToken> {
    const key = tokenCacheKey(identity, audience, scopes, oauth?.clientId);
    const cached = this.cache.get(key) ?? (await this.loadStored(key));
    if (cached && this.isValid(cached)) {
      this.cache.set(key, cached);
      return cached;
    }
    return this.refresh(identity, audience, scopes, oauth);
  }

  async refresh(identity: string, audience: string, scopes: string[], oauth?: OAuthClientRef): Promise<AccessToken> {
    const key = tokenCacheKey(identity, audience, scopes, oauth?.clientId);
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }
    const work = this.refreshOnce(key, identity, audience, scopes, oauth);
    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async refreshOnce(key: string, identity: string, audience: string, scopes: string[], oauth?: OAuthClientRef): Promise<AccessToken> {
    // Only now that a mint is actually happening do we resolve the OAuth
    // secret — a cache hit in get() never reaches here, so a valid cached
    // token survives an empty/removed env secret.
    const creds = oauth?.resolve();
    const candidates = this.providers.filter((provider) => !provider.accepts || provider.accepts(identity, audience, scopes, creds));
    if (candidates.length === 0) {
      throw newError(KindToken, `no token provider accepts identity ${identity}`);
    }
    let lastErr: Error = newError(KindToken, "no token provider available");
    for (const provider of candidates) {
      try {
        const tok = await withRetry(() => provider.fetch(identity, audience, scopes, creds), {
          attempts: TOKEN_RETRY_MAX,
          backoffMs: TOKEN_RETRY_BACKOFF_MS,
          retry: isTransientTokenError,
        });
        this.cache.set(key, tok);
        persistTokenMeta(key, tok);
        await this.store.set(key, toRecord(tok));
        this.bus?.publish(newEvent(TokenRefreshed, "", { identity: tok.identity, audience: tok.audience }));
        return tok;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    this.bus?.publish(newEvent(TokenRefreshFailed, "", { identity, audience, error: humanMessage(lastErr) }));
    throw lastErr;
  }

  private async loadStored(key: string): Promise<AccessToken | undefined> {
    const rec = await this.store.get(key);
    if (!rec || rec.accessToken === "") {
      return undefined;
    }
    return fromRecord(rec);
  }

  private async clearStore(): Promise<void> {
    const entries = await this.store.list();
    await Promise.all(entries.map((entry) => this.store.delete(entry.key)));
  }
}

export function tokenMetaPath(key: string): string {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(credentialsDir(), `${id}.json`);
}

function persistTokenMeta(key: string, tok: AccessToken): void {
  const meta: TokenMeta = {
    identity: tok.identity,
    audience: tok.audience,
    expires_at: tok.expiresAt.toISOString(),
    scopes: tok.scopes,
  };
  writeFileSecure(tokenMetaPath(key), `${JSON.stringify(meta)}\n`);
}

function toRecord(tok: AccessToken): CredentialRecord {
  return {
    identity: tok.identity,
    audience: tok.audience,
    scopes: tok.scopes,
    accessToken: tok.accessToken,
    tokenType: tok.tokenType,
    expiresAt: tok.expiresAt.toISOString(),
  };
}

function fromRecord(rec: CredentialRecord): AccessToken {
  return {
    accessToken: rec.accessToken,
    tokenType: rec.tokenType || "Bearer",
    expiresAt: new Date(rec.expiresAt),
    audience: rec.audience,
    identity: rec.identity,
    scopes: rec.scopes,
  };
}

export function googleTokenProviders(): TokenProvider[] {
  return [iapProvider(), serviceAccountProvider(), userProvider()];
}

function userProvider(): TokenProvider {
  return {
    name: "user",
    accepts: (identity, audience) => !identity.startsWith("sa:") && audience === "",
    fetch: async (identity, audience, scopes) => {
      if (identity.startsWith("sa:")) {
        throw newError(KindToken, "user provider cannot mint service-account tokens");
      }
      return fetchUserToken(identity, audience, scopes);
    },
  };
}

function serviceAccountProvider(): TokenProvider {
  return {
    name: "service_account",
    accepts: (identity, audience) => identity.startsWith("sa:") && audience === "",
    fetch: async (identity, audience, scopes) => {
      if (!identity.startsWith("sa:")) {
        throw newError(KindToken, "service-account provider cannot mint user tokens");
      }
      return fetchImpersonatedAccessToken(identity, audience, scopes);
    },
  };
}

function iapProvider(): TokenProvider {
  return {
    name: "iap",
    accepts: (_identity, audience) => audience !== "",
    fetch: async (identity, audience, scopes, oauth) => {
      if (audience === "") {
        throw newError(KindToken, "IAP audience is required");
      }
      if (identity.startsWith("sa:")) {
        return fetchImpersonatedIdToken(identity, audience, scopes);
      }
      return fetchUserIdToken(identity, audience, scopes, oauth);
    },
  };
}

async function fetchImpersonatedAccessToken(identity: string, audience: string, scopes: string[]): Promise<AccessToken> {
  const email = identity.slice(3);
  try {
    ensureFetchShim();
    const auth = new GoogleAuth({ scopes: scopes.length > 0 ? scopes : [CLOUD_SCOPE] });
    const source = await auth.getClient();
    const impersonated = new Impersonated({
      sourceClient: source,
      targetPrincipal: email,
      targetScopes: scopes.length > 0 ? scopes : [CLOUD_SCOPE],
      lifetime: 3600,
    });
    const tok = await impersonated.getAccessToken();
    const accessToken = typeof tok === "string" ? tok : tok?.token;
    if (!accessToken) {
      throw newError(KindToken, "empty impersonated token");
    }
    return {
      accessToken,
      tokenType: "Bearer",
      expiresAt: expiryFromToken(accessToken, impersonated),
      audience,
      identity,
      scopes,
    };
  } catch (err) {
    throw classifyGoogle(err);
  }
}

async function fetchImpersonatedIdToken(identity: string, audience: string, scopes: string[]): Promise<AccessToken> {
  const email = identity.slice(3);
  try {
    ensureFetchShim();
    const auth = new GoogleAuth({ scopes: [CLOUD_SCOPE] });
    const client = await auth.getClient();
    const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateIdToken`;
    const res = await client.request<{ token?: string }>({
      url,
      method: "POST",
      data: { audience, includeEmail: true },
    });
    const accessToken = res.data.token;
    if (!accessToken) {
      throw newError(KindToken, "empty impersonated IAP id token");
    }
    return {
      accessToken,
      tokenType: "Bearer",
      expiresAt: expiryFromToken(accessToken),
      audience,
      identity,
      scopes,
    };
  } catch (err) {
    throw classifyGoogle(err);
  }
}

async function fetchUserIdToken(identity: string, audience: string, scopes: string[], oauth?: OAuthClientCredentials): Promise<AccessToken> {
  try {
    ensureFetchShim();
    if (oauth) {
      return await fetchUserIdTokenWithOAuthClient(identity, audience, scopes, oauth);
    }
    const auth = new GoogleAuth({ scopes: scopes.length > 0 ? scopes : [IAP_SCOPE] });
    const client = await auth.getIdTokenClient(audience);
    const tok = await client.idTokenProvider.fetchIdToken(audience);
    return {
      accessToken: tok,
      tokenType: "Bearer",
      expiresAt: expiryFromToken(tok),
      audience,
      identity,
      scopes,
    };
  } catch (err) {
    if (err instanceof DevctlError) {
      throw err;
    }
    throw classifyGoogle(err);
  }
}

async function fetchUserIdTokenWithOAuthClient(identity: string, audience: string, scopes: string[], oauth: OAuthClientCredentials): Promise<AccessToken> {
  // A route-supplied credentials file gives a refresh token issued by the
  // custom client itself — use it directly and never touch ADC. Otherwise fall
  // back to the ADC refresh token (which only works when ADC was itself logged
  // in with this same client).
  let refreshToken = oauth.refreshToken;
  if (!refreshToken) {
    const auth = new GoogleAuth({ scopes: scopes.length > 0 ? scopes : [IAP_SCOPE] });
    const adc = await auth.getClient();
    refreshToken = adc.credentials.refresh_token ?? undefined;
    if (!refreshToken) {
      throw hintError(
        KindAuthentication,
        "ADC has no refresh token for a custom IAP OAuth client",
        "set auth.credentials (or proxy.credentials) to an authorized_user file whose refresh_token was issued by this client_id, or run `gcloud auth application-default login` with that client",
      );
    }
  }
  const client = new UserRefreshClient({
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
    refreshToken,
  });
  const tok = await client.fetchIdToken(audience);
  if (!tok) {
    throw newError(KindToken, "empty IAP id token");
  }
  return {
    accessToken: tok,
    tokenType: "Bearer",
    expiresAt: expiryFromToken(tok),
    audience,
    identity,
    scopes,
  };
}

async function fetchUserToken(identity: string, audience: string, scopes: string[]): Promise<AccessToken> {
  try {
    ensureFetchShim();
    const auth = new GoogleAuth({ scopes: scopes.length > 0 ? scopes : [CLOUD_SCOPE] });
    const client = await auth.getClient();
    const tok = await client.getAccessToken();
    if (!tok.token) {
      throw newError(KindToken, "empty access token");
    }
    return {
      accessToken: tok.token,
      tokenType: "Bearer",
      expiresAt: expiryFromCredentials(client, tok.token),
      audience,
      identity,
      scopes,
    };
  } catch (err) {
    throw classifyGoogle(err);
  }
}

function expiryFromToken(token: string, client?: { credentials?: { expiry_date?: number | null } }): Date {
  if (client?.credentials?.expiry_date) {
    return new Date(client.credentials.expiry_date);
  }
  const fromJwt = jwtExpiry(token);
  return fromJwt ?? new Date(Date.now() + FALLBACK_TTL_MS);
}

function expiryFromCredentials(client: { credentials?: { expiry_date?: number | null } }, token: string): Date {
  return expiryFromToken(token, client);
}

function jwtExpiry(token: string): Date | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return undefined;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: number };
    if (typeof payload.exp === "number") {
      return new Date(payload.exp * 1000);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isTransientTokenError(err: unknown): boolean {
  if (err instanceof DevctlError) {
    return err.kind !== KindConfiguration && err.kind !== KindAuthorization;
  }
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("network") || message.includes("econnreset") || message.includes("etimedout") || message.includes("503") || message.includes("429");
}

