import { mkdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { decodeCommand } from "./config/decode.ts";
import { defaultConfig } from "./config/types.ts";
import { KindProxy } from "./errors.ts";
import { INTERNAL_TOKEN_HEADER, ProxyServer, TokenEndpoint } from "./proxy.ts";
import { Detector } from "./secrets.ts";
import { TokenManager, type AccessToken } from "./token.ts";

function token(partial: Partial<AccessToken> = {}): AccessToken {
  return {
    accessToken: "leaked-secret",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 60_000),
    audience: "",
    identity: "user",
    scopes: [],
    ...partial,
  };
}

describe("security", () => {
  test("token endpoint refuses 0.0.0.0", async () => {
    const tokens = new TokenManager(60_000, [{ name: "stub", fetch: async () => token() }]);
    const ep = new TokenEndpoint("0.0.0.0", 0, "internal", tokens);
    await expect(ep.start()).rejects.toMatchObject({ kind: KindProxy });
  });

  test("token endpoint requires the internal header", async () => {
    const tokens = new TokenManager(60_000, [{ name: "stub", fetch: async () => token() }]);
    const ep = new TokenEndpoint("127.0.0.1", 0, "internal-secret", tokens);
    await ep.start();
    const port = ep.listenPort();
    const denied = await fetch(`http://127.0.0.1:${port}/token`);
    expect(denied.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${port}/token`, { headers: { [INTERNAL_TOKEN_HEADER]: "nope" } });
    expect(wrong.status).toBe(401);
    await ep.stop();
  });

  test("shell:false keeps metacharacters as argv tokens", () => {
    const cmd = decodeCommand("echo hi && rm -rf /");
    expect(cmd.shell).toBe(false);
    expect(cmd.args).toContain("&&");
  });

  test("detector redacts tokens from proxy-style lines", () => {
    const detector = new Detector(["secret"], []);
    expect(detector.redactText("Authorization: Bearer leaked-secret")).not.toContain("leaked-secret");
  });

  test("proxy still refuses 0.0.0.0", async () => {
    const cfg = defaultConfig().proxy;
    cfg.listen = { host: "0.0.0.0", port: 18998 };
    await expect(new ProxyServer(cfg).start()).rejects.toMatchObject({ kind: KindProxy });
  });
});

describe("isolated home", () => {
  test("DEVCTL_HOME keeps credentials out of the repo", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-sec-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = dir;
    expect(dir.includes("devctl-sec")).toBe(true);
  });
});
