import { createHash } from "node:crypto";
import { join } from "node:path";
import { GoogleAuth, Impersonated } from "google-auth-library";
import { type CredentialRecord, type CredentialStatus, type CredentialStore, openCredentialStore } from "./credentials.ts";
import { DevctlError, KindAuthorization, KindConfiguration, KindToken, newError } from "./errors.ts";
import { type Bus, TokenRefreshed, newEvent } from "./events.ts";
import { classifyGoogle } from "./google.ts";
import { credentialsDir, writeFileSecure } from "./storage.ts";

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

export type TokenProvider = {
  name: string;
  accepts?: (identity: string, audience: string, scopes: string[]) => boolean;
  fetch: (identity: string, audience: string, scopes: string[]) => Promise<AccessToken>;
};

export type TokenMeta = {
  identity: string;
  audience: string;
  expires_at: string;
  scopes: string[];
};

export function tokenCacheKey(identity: string, audience: string, scopes: string[]): string {
  return `${identity}|${audience}|${scopes.join(",")}`;
}

export function isValidToken(tok: AccessToken, thresholdMs = DEFAULT_THRESHOLD_MS): boolean {
  if (tok.accessToken === "") {
    return false;
  }
  return tok.expiresAt.getTime() - Date.now() >= thresholdMs;
}

export function expiresSoonToken(tok: AccessToken, thresholdMs = DEFAULT_THRESHOLD_MS): boolean {
  if (tok.accessToken === "") {
    return true;
  }
  const remaining = tok.expiresAt.getTime() - Date.now();
  return remaining > 0 && remaining < thresholdMs;
}

export class TokenManager {
  private readonly cache = new Map<string, AccessToken>();
  private readonly inflight = new Map<string, Promise<AccessToken>>();
  private readonly providers: TokenProvider[];
  private readonly thresholdMs: number;
  private readonly bus?: Bus;
  private readonly store: CredentialStore;

  constructor(thresholdMs: number, providers: TokenProvider[], bus?: Bus, store?: CredentialStore) {
    this.thresholdMs = thresholdMs > 0 ? thresholdMs : DEFAULT_THRESHOLD_MS;
    this.providers = [...providers];
    this.bus = bus;
    this.store = store ?? openCredentialStore(process.env.DEVCTL_CREDENTIAL_BACKEND === "file" ? "file" : undefined);
  }

  replaceProviders(providers: TokenProvider[]): void {
    this.providers.splice(0, this.providers.length, ...providers);
  }

  isValid(tok: AccessToken): boolean {
    return isValidToken(tok, this.thresholdMs);
  }

  expiresSoon(tok: AccessToken): boolean {
    return expiresSoonToken(tok, this.thresholdMs);
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

  async get(identity: string, audience: string, scopes: string[]): Promise<AccessToken> {
    const key = tokenCacheKey(identity, audience, scopes);
    const cached = this.cache.get(key) ?? (await this.loadStored(key));
    if (cached && this.isValid(cached)) {
      this.cache.set(key, cached);
      return cached;
    }
    return this.refresh(identity, audience, scopes);
  }

  async refresh(identity: string, audience: string, scopes: string[]): Promise<AccessToken> {
    const key = tokenCacheKey(identity, audience, scopes);
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }
    const work = this.refreshOnce(key, identity, audience, scopes);
    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async refreshOnce(key: string, identity: string, audience: string, scopes: string[]): Promise<AccessToken> {
    const candidates = this.providers.filter((provider) => !provider.accepts || provider.accepts(identity, audience, scopes));
    if (candidates.length === 0) {
      throw newError(KindToken, `no token provider accepts identity ${identity}`);
    }
    let lastErr: Error = newError(KindToken, "no token provider available");
    for (const provider of candidates) {
      for (let attempt = 0; attempt < TOKEN_RETRY_MAX; attempt += 1) {
        try {
          const tok = await provider.fetch(identity, audience, scopes);
          this.cache.set(key, tok);
          persistTokenMeta(key, tok);
          await this.store.set(key, toRecord(tok));
          this.bus?.publish(newEvent(TokenRefreshed, "", { identity: tok.identity, audience: tok.audience }));
          return tok;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (!isTransientTokenError(err) || attempt === TOKEN_RETRY_MAX - 1) {
            break;
          }
          await sleep(TOKEN_RETRY_BACKOFF_MS * (attempt + 1));
        }
      }
    }
    throw lastErr;
  }

  private async loadStored(key: string): Promise<AccessToken | undefined> {
    const rec = await this.store.get(key);
    if (!rec) {
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

export function staticTokenProvider(token: AccessToken): TokenProvider {
  return {
    name: "static",
    accepts: (identity, audience) => (token.identity === "" || identity === token.identity) && (token.audience === "" || audience === token.audience),
    fetch: async (identity, audience, scopes) => ({ ...token, identity, audience, scopes }),
  };
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
    fetch: async (identity, audience, scopes) => {
      if (audience === "") {
        throw newError(KindToken, "IAP audience is required");
      }
      if (identity.startsWith("sa:")) {
        return fetchImpersonatedIdToken(identity, audience, scopes);
      }
      return fetchUserIdToken(identity, audience, scopes);
    },
  };
}

async function fetchImpersonatedAccessToken(identity: string, audience: string, scopes: string[]): Promise<AccessToken> {
  const email = identity.slice(3);
  try {
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

async function fetchUserIdToken(identity: string, audience: string, scopes: string[]): Promise<AccessToken> {
  try {
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
    throw classifyGoogle(err);
  }
}

async function fetchUserToken(identity: string, audience: string, scopes: string[]): Promise<AccessToken> {
  try {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
