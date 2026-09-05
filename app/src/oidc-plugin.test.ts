import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { emptyIdentity as emptyIdentityConfig } from "./domain/config/types.ts";
import { identityProviders, tokenProviders } from "../../plugins/oidc/index.ts";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()));

describe("OIDC reference plugin", () => {
  test("discovers an issuer and mints a client-credentials token", async () => {
    let tokenBody = "";
    server = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ token_endpoint: `http://127.0.0.1:${(server!.address() as { port: number }).port}/token` }));
        return;
      }
      req.on("data", (chunk) => { tokenBody += chunk.toString(); });
      req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ access_token: "oidc-token", token_type: "Bearer", expires_in: 60 })); });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const cfg = { ...emptyIdentityConfig(), type: "oidc", config: { issuer, client_id: "devctl", client_secret: "secret", scopes: ["read"] } };
    const identity = await identityProviders[0]!.resolve(cfg, async () => { throw new Error("OIDC must not invoke Google detection"); });
    const token = await tokenProviders[0]!.fetch(identity.tokenKey, "api", []);
    expect(token.accessToken).toBe("oidc-token");
    expect(token.identity).toBe(`oidc:devctl@${issuer}`);
    expect(tokenBody).toContain("grant_type=client_credentials");
    expect(tokenBody).toContain("scope=read");
    expect(tokenBody).toContain("audience=api");
  });
});
