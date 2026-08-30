import { describe, expect, test } from "bun:test";
import { Registry } from "./plugins.ts";

describe("plugin registry", () => {
  test("registers built-in token identity log and proxy hooks", () => {
    const registry = new Registry();
    registry.registerBuiltins();
    expect(registry.tokenProviders.some((p) => p.name === "iap")).toBe(true);
    expect(registry.identityProviders.some((p) => p.name === "service_account")).toBe(true);
    expect(registry.logParsers.some((p) => p.name === "default")).toBe(true);
    expect(registry.proxyMiddleware.some((p) => p.name === "identity_inject")).toBe(true);
  });
});
