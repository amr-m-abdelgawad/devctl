import {
  DEFAULT_REFRESH_THRESHOLD_SECONDS,
  httpCacheEnabled,
  httpRecipeLocalUrl,
  httpTimeoutSeconds,
  type DevctlConfig,
  type HttpRecipeConfig,
} from "../../domain/config/types.ts";
import { KindConfiguration, newError } from "../../shared/errors.ts";
import { getJsonPath, jsonValueToString } from "../../domain/http/json-path.ts";
import { jwtExpiry } from "../../domain/http/jwt.ts";
import {
  httpRecipesReferencedBy,
  JWT_TOKEN_FIELDS,
  recipeAuthMintsToken,
} from "../../domain/http/recipes.ts";
import type { Clock } from "../../ports/clock.ts";
import type { HttpRecipeRuntime, HttpRecipeSnapshot } from "../../ports/http-recipe-runtime.ts";
import { resolveString, type HttpValueMap } from "../config/refs.ts";
import { mintAuthToken } from "./identity.ts";
import { assignedPorts } from "./assigned-ports.ts";
import { authorizedSend } from "./send.ts";
import type { TokenManager } from "../google/token.ts";

const MS_PER_SECOND = 1000;
const GET = "GET";

export type RecipeFetch = (input: string, init: RequestInit) => Promise<Response>;
export type RecipeScheduler = (ms: number, fn: () => void) => { cancel: () => void };

export type RecipeRuntimeDeps = {
  cfg: () => DevctlConfig;
  tokens: TokenManager;
  clock: Clock;
  userEmail: () => string;
  ports: () => Map<string, Record<string, number>>;
  processEnv: () => NodeJS.ProcessEnv;
  fetch?: RecipeFetch;
  schedule?: RecipeScheduler;
  log?: (message: string) => void;
};

type CacheEntry = {
  snapshot: HttpRecipeSnapshot;
  inflight?: Promise<HttpRecipeSnapshot>;
  timer?: { cancel: () => void };
};

export class RecipeRuntime implements HttpRecipeRuntime {
  private readonly entries = new Map<string, CacheEntry>();
  private running = true;
  private readonly deps: RecipeRuntimeDeps;
  private readonly fetchImpl: RecipeFetch;
  private readonly schedule: RecipeScheduler;

  constructor(deps: RecipeRuntimeDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.schedule = deps.schedule ?? defaultSchedule;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
  }

  reset(): void {
    this.clearTimers();
    this.entries.clear();
  }

  snapshot(name: string): HttpRecipeSnapshot | undefined {
    return this.entries.get(name)?.snapshot;
  }

  async ensure(name: string): Promise<HttpRecipeSnapshot> {
    const recipe = this.requireRecipe(name);
    const entry = this.entries.get(name);
    if (entry?.inflight) {
      return entry.inflight;
    }
    if (entry && this.isFresh(recipe, entry.snapshot)) {
      return entry.snapshot;
    }
    const work = this.refresh(name, entry);
    const next: CacheEntry = { snapshot: entry?.snapshot ?? emptySnapshot(), inflight: work, timer: entry?.timer };
    this.entries.set(name, next);
    try {
      return await work;
    } finally {
      const current = this.entries.get(name);
      if (current?.inflight === work) {
        current.inflight = undefined;
      }
    }
  }

  private async refresh(name: string, previous: CacheEntry | undefined): Promise<HttpRecipeSnapshot> {
    try {
      const snapshot = await this.fetchRecipe(name);
      this.store(name, snapshot, previous?.timer);
      this.armTimer(name, snapshot);
      return snapshot;
    } catch (err) {
      if (previous?.snapshot && this.notExpired(previous.snapshot)) {
        this.deps.log?.(`http recipe ${name} refresh failed; keeping cached body until expiry`);
        return previous.snapshot;
      }
      throw err;
    }
  }

  private async fetchRecipe(name: string): Promise<HttpRecipeSnapshot> {
    const cfg = this.deps.cfg();
    const recipe = this.requireRecipe(name);
    for (const dep of httpRecipesReferencedBy(recipe)) {
      await this.ensure(dep);
    }
    const token = recipeAuthMintsToken(recipe) ? await mintAuthToken(recipe.request.auth, this.deps.tokens) : undefined;
    const extras = {
      http: this.valueMap(),
      token,
      processEnv: this.deps.processEnv(),
    };
    const assigned = assignedPorts(cfg, this.deps.ports());
    const userEmail = this.deps.userEmail();
    const interpolate = (value: string): string => resolveString(value, cfg, assigned, userEmail, extras);
    const url = interpolate(recipe.request.url);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(recipe.request.headers)) {
      headers[key] = interpolate(value);
    }
    const method = (recipe.request.method || GET).toUpperCase();
    const body = encodeBody(recipe, interpolate, headers);
    const timeoutMs = httpTimeoutSeconds(recipe) * MS_PER_SECOND;
    const resp = await authorizedSend(
      { url, method, headers, body, timeoutMs },
      { token, extraHeaders: recipe.request.auth.headers },
      this.fetchImpl,
    );
    const text = await resp.text();
    const snapshot = buildSnapshot(cfg, name, recipe, resp.status, resp.headers.get("content-type") ?? "", text, this.deps.clock.unixMs());
    this.deps.log?.(`http recipe ${name} fetched status=${resp.status}`);
    return snapshot;
  }

  private store(name: string, snapshot: HttpRecipeSnapshot, timer?: { cancel: () => void }): void {
    this.entries.set(name, { snapshot, timer });
  }

  private armTimer(name: string, snapshot: HttpRecipeSnapshot): void {
    const entry = this.entries.get(name);
    entry?.timer?.cancel();
    if (!this.running || !snapshot.expiresAt) {
      return;
    }
    const delay = snapshot.expiresAt.getTime() - this.deps.clock.unixMs() - this.thresholdMs();
    if (delay <= 0) {
      return;
    }
    const timer = this.schedule(delay, () => {
      void this.ensure(name).catch((err) => {
        this.deps.log?.(`http recipe ${name} proactive refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    const current = this.entries.get(name);
    if (current) {
      current.timer = timer;
    }
  }

  private isFresh(recipe: HttpRecipeConfig, snapshot: HttpRecipeSnapshot): boolean {
    if (!httpCacheEnabled(recipe) || !snapshot.expiresAt) {
      return false;
    }
    return snapshot.expiresAt.getTime() - this.deps.clock.unixMs() >= this.thresholdMs();
  }

  private notExpired(snapshot: HttpRecipeSnapshot): boolean {
    return snapshot.expiresAt !== undefined && snapshot.expiresAt.getTime() > this.deps.clock.unixMs();
  }

  private thresholdMs(): number {
    const seconds = this.deps.cfg().auth.refresh_threshold_seconds;
    return (seconds > 0 ? seconds : DEFAULT_REFRESH_THRESHOLD_SECONDS) * MS_PER_SECOND;
  }

  private requireRecipe(name: string): HttpRecipeConfig {
    const recipe = this.deps.cfg().http[name];
    if (!recipe) {
      throw newError(KindConfiguration, `unknown http recipe "${name}"`);
    }
    return recipe;
  }

  private valueMap(): HttpValueMap {
    const out: HttpValueMap = {};
    for (const [name, entry] of this.entries) {
      out[name] = entry.snapshot.values;
    }
    return out;
  }

  private clearTimers(): void {
    for (const entry of this.entries.values()) {
      entry.timer?.cancel();
      entry.timer = undefined;
    }
  }
}

function defaultSchedule(ms: number, fn: () => void): { cancel: () => void } {
  const timer = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(timer) };
}

function emptySnapshot(): HttpRecipeSnapshot {
  return { status: 0, body: "", contentType: "", values: {} };
}

function encodeBody(recipe: HttpRecipeConfig, interpolate: (value: string) => string, headers: Record<string, string>): string | undefined {
  const formKeys = Object.keys(recipe.request.form);
  if (formKeys.length > 0) {
    const params = new URLSearchParams();
    for (const key of formKeys) {
      params.append(key, interpolate(recipe.request.form[key] ?? ""));
    }
    if (!headerHasContentType(headers)) {
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    return params.toString();
  }
  if (recipe.request.body === "") {
    return undefined;
  }
  return interpolate(recipe.request.body);
}

function headerHasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
}

function buildSnapshot(
  cfg: DevctlConfig,
  name: string,
  recipe: HttpRecipeConfig,
  status: number,
  contentType: string,
  body: string,
  nowMs: number,
): HttpRecipeSnapshot {
  const parsed = parseJsonBody(body);
  const values: Record<string, string> = {
    body,
    status: String(status),
    url: httpRecipeLocalUrl(cfg, name),
  };
  for (const [output, path] of Object.entries(recipe.outputs)) {
    if (parsed === undefined) {
      throw newError(KindConfiguration, `http recipe ${name} output ${output} requires a JSON body`);
    }
    const found = getJsonPath(parsed, path);
    if (found === undefined) {
      throw newError(KindConfiguration, `http recipe ${name} output ${output} path "${path}" is missing`);
    }
    try {
      values[output] = jsonValueToString(found);
    } catch {
      throw newError(KindConfiguration, `http recipe ${name} output ${output} path "${path}" is missing`);
    }
  }
  const expiresAt = resolveExpiry(name, recipe, parsed, values, nowMs);
  return { status, body, contentType, values, expiresAt };
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function resolveExpiry(
  name: string,
  recipe: HttpRecipeConfig,
  parsed: unknown,
  values: Record<string, string>,
  nowMs: number,
): Date | undefined {
  if (!httpCacheEnabled(recipe)) {
    return undefined;
  }
  const jwtAt = recipe.cache.jwt ? jwtExpiryFrom(name, parsed, values) : undefined;
  const oauthAt = recipe.cache.expires_in !== "" ? expiresInAt(name, recipe, parsed, nowMs) : undefined;
  if (jwtAt && oauthAt) {
    return jwtAt.getTime() < oauthAt.getTime() ? jwtAt : oauthAt;
  }
  return jwtAt ?? oauthAt;
}

function jwtExpiryFrom(name: string, parsed: unknown, values: Record<string, string>): Date {
  const candidates: string[] = [];
  for (const value of Object.values(values)) {
    candidates.push(value);
  }
  if (parsed !== null && parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const field of JWT_TOKEN_FIELDS) {
      const value = record[field];
      if (typeof value === "string") {
        candidates.push(value);
      }
    }
  }
  let earliest: Date | undefined;
  for (const candidate of candidates) {
    const exp = jwtExpiry(candidate);
    if (exp && (!earliest || exp.getTime() < earliest.getTime())) {
      earliest = exp;
    }
  }
  if (!earliest) {
    throw newError(KindConfiguration, `http recipe ${name} cache.jwt is set but no JWT exp was found`);
  }
  return earliest;
}

function expiresInAt(name: string, recipe: HttpRecipeConfig, parsed: unknown, nowMs: number): Date {
  if (parsed === undefined) {
    throw newError(KindConfiguration, `http recipe ${name} cache.expires_in requires a JSON body`);
  }
  const raw = getJsonPath(parsed, recipe.cache.expires_in);
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw newError(KindConfiguration, `http recipe ${name} cache.expires_in path "${recipe.cache.expires_in}" is missing or not a positive number`);
  }
  return new Date(nowMs + seconds * MS_PER_SECOND);
}
