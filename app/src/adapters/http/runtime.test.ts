import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyHttpRecipe, emptyRouteAuth, emptyService } from "../../domain/config/types.ts";
import type { Clock } from "../../ports/clock.ts";
import { TokenManager, type AccessToken } from "../google/token.ts";
import { RecipeRuntime } from "./runtime.ts";

function jwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function token(partial: Partial<AccessToken> = {}): AccessToken {
  return {
    accessToken: "google-id-token",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 60_000),
    audience: "",
    identity: "user",
    scopes: [],
    ...partial,
  };
}

function clockAt(nowMs: { value: number }): Clock {
  return {
    now: () => new Date(nowMs.value),
    isoNow: () => new Date(nowMs.value).toISOString(),
    unixMs: () => nowMs.value,
  };
}

function recipeRuntime(opts: {
  nowMs: { value: number };
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  cfg?: ReturnType<typeof defaultConfig>;
  env?: NodeJS.ProcessEnv;
  schedule?: (ms: number, fn: () => void) => { cancel: () => void };
}) {
  const cfg = opts.cfg ?? defaultConfig();
  cfg.auth.refresh_threshold_seconds = 300;
  if (!cfg.services.api) {
    cfg.services.api = { ...emptyService(), command: { args: ["api"], shell: false } };
  }
  const tokens = new TokenManager(60_000, [{ name: "stub", fetch: async () => token() }], undefined, {
    backend: "file",
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  });
  const runtime = new RecipeRuntime({
    cfg: () => cfg,
    tokens,
    clock: clockAt(opts.nowMs),
    userEmail: () => "dev@example.com",
    ports: () => new Map(),
    processEnv: () => opts.env ?? {},
    fetch: opts.fetch,
    schedule: opts.schedule,
  });
  return { cfg, runtime, tokens };
}

describe("RecipeRuntime", () => {
  test("encodes form bodies, interpolates env and ${token}, and skips Bearer when Authorization is set", async () => {
    const nowMs = { value: 1_000_000 };
    const seen: { url: string; headers: Headers; body: string }[] = [];
    const { cfg, runtime } = recipeRuntime({
      nowMs,
      env: { APIGEE_BASIC: "Y2xpZW50OnNlY3JldA==" },
      fetch: async (url, init) => {
        seen.push({ url, headers: new Headers(init.headers), body: String(init.body ?? "") });
        return new Response(JSON.stringify({ access_token: "opaque", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    cfg.http["apigee-token"] = {
      ...emptyHttpRecipe(),
      request: {
        method: "POST",
        url: "https://api.company.com/v1/oauth/token",
        headers: { Authorization: "Basic ${APIGEE_BASIC}", "X-User": "${identity.user}" },
        body: "",
        form: {
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: "${token}",
          subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        },
        auth: { ...emptyRouteAuth(), type: "iap", audience: "aud", identity: { type: "user", service_account: "" } },
        timeout_seconds: 10,
      },
      outputs: { token: "access_token" },
      cache: { jwt: false, expires_in: "expires_in" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    const snap = await runtime.ensure("apigee-token");
    expect(snap.values.token).toBe("opaque");
    expect(snap.values.body).toContain("access_token");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("authorization")).toBe("Basic Y2xpZW50OnNlY3JldA==");
    expect(seen[0]?.headers.get("x-user")).toBe("dev@example.com");
    expect(seen[0]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(seen[0]?.body).toContain("subject_token=google-id-token");
    expect(seen[0]?.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange");
    await runtime.ensure("apigee-token");
    expect(seen).toHaveLength(1);
    nowMs.value += (3600 - 299) * 1000;
    await runtime.ensure("apigee-token");
    expect(seen).toHaveLength(2);
  });

  test("blocks a recipe URL that targets a link-local / metadata host before fetching", async () => {
    const nowMs = { value: 1_000_000 };
    let called = 0;
    const { cfg, runtime } = recipeRuntime({
      nowMs,
      fetch: async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      },
    });
    cfg.http.exfil = {
      ...emptyHttpRecipe(),
      request: { method: "GET", url: "http://169.254.169.254/computeMetadata/v1/", headers: {}, body: "", form: {}, auth: { ...emptyRouteAuth(), type: "none" }, timeout_seconds: 10 },
      outputs: {},
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    await expect(runtime.ensure("exfil")).rejects.toThrow(/link-local or metadata/);
    expect(called).toBe(0);
  });

  test("rejects a recipe response larger than the byte cap", async () => {
    const nowMs = { value: 1_000_000 };
    const { cfg, runtime } = recipeRuntime({
      nowMs,
      fetch: async () => new Response("x".repeat(1024 * 1024 + 1024), { status: 200 }),
    });
    cfg.http.huge = {
      ...emptyHttpRecipe(),
      request: {
        method: "GET",
        url: "https://api.example.com/data",
        headers: {},
        body: "",
        form: {},
        auth: { ...emptyRouteAuth(), type: "none" },
        timeout_seconds: 10,
      },
      outputs: {},
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    await expect(runtime.ensure("huge")).rejects.toThrow(/exceeds/);
  });

  test("injects Bearer when Authorization is unset", async () => {
    const nowMs = { value: 1_000_000 };
    let authorization = "";
    const { cfg, runtime } = recipeRuntime({
      nowMs,
      fetch: async (_url, init) => {
        authorization = new Headers(init.headers).get("authorization") ?? "";
        return new Response("{}", { status: 200 });
      },
    });
    cfg.http.login = {
      ...emptyHttpRecipe(),
      request: {
        method: "GET",
        url: "https://iap.example/token",
        headers: {},
        body: "",
        form: {},
        auth: { ...emptyRouteAuth(), type: "iap", audience: "aud", identity: { type: "user", service_account: "" } },
        timeout_seconds: 10,
      },
      outputs: {},
      cache: { jwt: false, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    await runtime.ensure("login");
    expect(authorization).toBe("Bearer google-id-token");
  });

  test("caches from JWT exp and coalesces in-flight fetches", async () => {
    const nowMs = { value: 1_700_000_000_000 };
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { cfg, runtime } = recipeRuntime({
      nowMs,
      fetch: async () => {
        calls += 1;
        await gate;
        return new Response(JSON.stringify({ access_token: jwt(Math.floor(nowMs.value / 1000) + 3600) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    cfg.http.login = {
      ...emptyHttpRecipe(),
      request: { ...emptyHttpRecipe().request, method: "GET", url: "https://idp.example/token" },
      outputs: { token: "access_token" },
      cache: { jwt: true, expires_in: "" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    const first = runtime.ensure("login");
    const second = runtime.ensure("login");
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  test("keeps the last valid body when a refresh fails before expiry", async () => {
    const nowMs = { value: 1_000_000 };
    let calls = 0;
    const { cfg, runtime } = recipeRuntime({
      nowMs,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ access_token: "one", expires_in: 3600 }), { status: 200 });
        }
        throw new Error("upstream down");
      },
    });
    cfg.http.login = {
      ...emptyHttpRecipe(),
      request: { ...emptyHttpRecipe().request, url: "https://idp.example/token" },
      outputs: { token: "access_token" },
      cache: { jwt: false, expires_in: "expires_in" },
      expose: { enabled: false, host: "", response_headers: {}, allow_token_body: false },
    };
    expect((await runtime.ensure("login")).values.token).toBe("one");
    nowMs.value += (3600 - 100) * 1000;
    expect((await runtime.ensure("login")).values.token).toBe("one");
    expect(calls).toBe(2);
  });

  test("interpolates ${services.*.url} and schedules a proactive refresh before expiry", async () => {
    const nowMs = { value: 1_000_000 };
    const scheduled: number[] = [];
    const seen: string[] = [];
    const { cfg, runtime } = recipeRuntime({
      nowMs,
      fetch: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ access_token: "opaque", expires_in: 3600 }), { status: 200 });
      },
      schedule: (ms) => {
        scheduled.push(ms);
        return { cancel: () => {} };
      },
    });
    cfg.services.identity = { ...emptyService(), command: { args: ["identity"], shell: false }, ports: [{ name: "http", value: 9000, auto: false }] };
    cfg.http.login = {
      ...emptyHttpRecipe(),
      request: { ...emptyHttpRecipe().request, method: "POST", url: "${services.identity.url}/oauth/token" },
      outputs: { token: "access_token" },
      cache: { jwt: false, expires_in: "expires_in" },
    };
    expect((await runtime.ensure("login")).values.token).toBe("opaque");
    expect(seen).toEqual(["http://127.0.0.1:9000/oauth/token"]);
    expect(scheduled).toEqual([3_300_000]);
  });
});
