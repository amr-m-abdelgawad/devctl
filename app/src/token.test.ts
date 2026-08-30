import { mkdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Bus, TokenRefreshed } from "./events.ts";
import { TokenManager, isValidToken, tokenCacheKey, tokenMetaPath, type AccessToken, type TokenProvider } from "./token.ts";

function tok(partial: Partial<AccessToken> = {}): AccessToken {
  return {
    accessToken: "tok",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    audience: "",
    identity: "user",
    scopes: [],
    ...partial,
  };
}

function home(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-token-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = dir;
  process.env.DEVCTL_CREDENTIAL_BACKEND = "file";
  return dir;
}

describe("TokenManager", () => {
  test("single-flight refresh shares one provider call", async () => {
    home();
    let calls = 0;
    const provider: TokenProvider = {
      name: "stub",
      fetch: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return tok();
      },
    };
    const mgr = new TokenManager(60_000, [provider]);
    const [a, b] = await Promise.all([mgr.get("user", "", []), mgr.get("user", "", [])]);
    expect(calls).toBe(1);
    expect(a.accessToken).toBe(b.accessToken);
  });

  test("invalidate forces the next get to refresh", async () => {
    home();
    let calls = 0;
    const provider: TokenProvider = {
      name: "stub",
      fetch: async () => {
        calls += 1;
        return tok({ accessToken: `n${calls}` });
      },
    };
    const mgr = new TokenManager(60_000, [provider]);
    expect((await mgr.get("user", "", [])).accessToken).toBe("n1");
    mgr.invalidate(tokenCacheKey("user", "", []));
    expect((await mgr.get("user", "", [])).accessToken).toBe("n2");
    expect(calls).toBe(2);
  });

  test("isValid rejects empty and soon-expiring tokens", () => {
    expect(isValidToken(tok({ accessToken: "" }))).toBe(false);
    expect(isValidToken(tok({ expiresAt: new Date(Date.now() + 1000) }), 5000)).toBe(false);
    expect(isValidToken(tok({ expiresAt: new Date(Date.now() + 60_000) }), 1000)).toBe(true);
  });

  test("persists metadata without the access token", async () => {
    home();
    const provider: TokenProvider = {
      name: "stub",
      fetch: async () => tok({ identity: "user:dev", audience: "aud" }),
    };
    const mgr = new TokenManager(60_000, [provider]);
    await mgr.get("user:dev", "aud", []);
    const path = tokenMetaPath(tokenCacheKey("user:dev", "aud", []));
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("tok");
    expect(raw).toContain("user:dev");
    expect(raw).toContain("aud");
  });

  test("does not let IAP mint a user token for a service account", async () => {
    home();
    const iap: TokenProvider = {
      name: "iap",
      accepts: (_identity, audience) => audience !== "",
      fetch: async (identity) => {
        if (identity.startsWith("sa:")) {
          return tok({ accessToken: "iap-sa", identity, audience: "aud" });
        }
        return tok({ accessToken: "iap-user", identity, audience: "aud" });
      },
    };
    const sa: TokenProvider = {
      name: "sa",
      accepts: (identity, audience) => identity.startsWith("sa:") && audience === "",
      fetch: async (identity) => tok({ accessToken: "sa-access", identity }),
    };
    const user: TokenProvider = {
      name: "user",
      accepts: (identity, audience) => !identity.startsWith("sa:") && audience === "",
      fetch: async () => tok({ accessToken: "user-access" }),
    };
    const mgr = new TokenManager(60_000, [iap, sa, user]);
    expect((await mgr.get("sa:worker@x", "aud", [])).accessToken).toBe("iap-sa");
    expect((await mgr.get("sa:worker@x", "", [])).accessToken).toBe("sa-access");
    expect((await mgr.get("user", "", [])).accessToken).toBe("user-access");
  });

  test("refresh and expiresSoon are public", async () => {
    home();
    let calls = 0;
    const mgr = new TokenManager(5_000, [
      {
        name: "stub",
        fetch: async () => {
          calls += 1;
          return tok({ accessToken: `n${calls}`, expiresAt: new Date(Date.now() + 60_000) });
        },
      },
    ]);
    const first = await mgr.get("user", "", []);
    expect(mgr.expiresSoon(first)).toBe(false);
    const second = await mgr.refresh("user", "", []);
    expect(second.accessToken).toBe("n2");
    expect(mgr.isValid(tok({ expiresAt: new Date(Date.now() + 1000) }))).toBe(false);
  });

  test("publishes TokenRefreshed after a successful refresh", async () => {
    home();
    const bus = new Bus(8);
    const seen: string[] = [];
    bus.subscribe((ev) => seen.push(ev.type), [TokenRefreshed]);
    const mgr = new TokenManager(60_000, [{ name: "stub", fetch: async () => tok() }], bus);
    await mgr.get("user", "", []);
    expect(seen).toEqual([TokenRefreshed]);
  });
});
