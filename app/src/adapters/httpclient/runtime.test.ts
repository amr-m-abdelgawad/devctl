import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, emptyHttpRecipe, emptyService } from "../../domain/config/types.ts";
import { VIRTUAL_COLLECTION_ID, emptyHttpClientRequest } from "../../domain/httpclient/request.ts";
import type { Clock } from "../../ports/clock.ts";
import { TokenManager, type AccessToken } from "../google/token.ts";
import { osFileSystem } from "../system/filesystem.ts";
import { HttpClientRuntime } from "./runtime.ts";

function token(partial: Partial<AccessToken> = {}): AccessToken {
  return {
    accessToken: "minted-devctl-token",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 60_000),
    audience: "",
    identity: "user",
    scopes: [],
    ...partial,
  };
}

function clock(): Clock {
  const now = Date.now();
  return { now: () => new Date(now), isoNow: () => new Date(now).toISOString(), unixMs: () => now };
}

function runtime(opts: {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  cfg?: ReturnType<typeof defaultConfig>;
  repoRoot?: string;
}) {
  const home = join(process.env.TMPDIR ?? "/tmp", `devctl-httpclient-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(home, { recursive: true });
  process.env.DEVCTL_HOME = home;
  const cfg = opts.cfg ?? defaultConfig();
  cfg.repoRoot = opts.repoRoot ?? join(import.meta.dir, "fixtures");
  if (!cfg.services.api) {
    cfg.services.api = { ...emptyService(), command: { args: ["api"], shell: false }, ports: [{ name: "http", value: 3999, auto: false }] };
    cfg.services.api.identity = { type: "user", mode: "", service_account: "", config: {} };
  }
  const tokens = new TokenManager(60_000, [{ name: "stub", fetch: async () => token() }], undefined, {
    backend: "file",
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  });
  return new HttpClientRuntime({
    cfg: () => cfg,
    tokens,
    clock: clock(),
    userEmail: () => "dev@example.com",
    ports: () => new Map(),
    processEnv: () => ({}),
    fs: osFileSystem,
    fetch: opts.fetch,
  });
}

describe("HttpClientRuntime", () => {
  test("lists the virtual collection beside discovered Bruno collections", () => {
    const client = runtime({ fetch: async () => new Response("ok") });
    const ids = client.listCollections().map((item) => item.id);
    expect(ids).toContain(VIRTUAL_COLLECTION_ID);
    expect(ids).toContain("sample-collection");
  });

  test("injects a token for a known service and not for an unknown host", async () => {
    const seen: { url: string; auth: string }[] = [];
    const cfg = defaultConfig();
    cfg.http.login = {
      ...emptyHttpRecipe(),
      request: {
        ...emptyHttpRecipe().request,
        method: "GET",
        url: "https://example.com/login",
      },
    };
    const client = runtime({
      cfg,
      fetch: async (url, init) => {
        const headers = new Headers(init.headers);
        seen.push({ url, auth: headers.get("authorization") ?? "" });
        return new Response("{\"ok\":true}", { status: 200, statusText: "OK", headers: { "content-type": "application/json" } });
      },
    });
    const known = await client.send({ collectionId: VIRTUAL_COLLECTION_ID, requestId: "service:api" });
    expect(known.tokenDecision).toBe("attach");
    expect(known.authAttached).toBe(true);
    expect(known.url).toBe("http://127.0.0.1:3999");
    expect(seen[0]?.auth).toBe("Bearer minted-devctl-token");

    const unknown = await client.send({ collectionId: VIRTUAL_COLLECTION_ID, requestId: "recipe:login" });
    expect(unknown.tokenDecision).toBe("skip");
    expect(unknown.authAttached).toBe(false);
    expect(seen[1]?.auth).toBe("");

    const polled = client.result(known.id);
    expect(polled?.status).toBe("ok");
    if (polled?.status === "ok") {
      expect(polled.result.response.body).toBe("");
      expect(polled.result.response.size).toBeGreaterThan(0);
    }
    expect(client.body(known.id).body).toContain("ok");
  });

  test("does not expand ${token} smuggled through a Bruno environment var", async () => {
    const seen: string[] = [];
    const client = runtime({
      fetch: async (url) => {
        seen.push(url);
        return new Response("ok", { status: 200 });
      },
    });
    const inline = emptyHttpClientRequest();
    inline.method = "GET";
    inline.url = "https://example.com/q={{stolen}}";
    const result = await client.send({
      collectionId: "sample-collection",
      inline,
      env: "local",
    });
    expect(result.url).toBe("https://example.com/q=${token}");
    expect(result.authAttached).toBe(false);
    expect(seen[0]).toBe("https://example.com/q=${token}");
  });
});
