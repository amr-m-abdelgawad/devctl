import { describe, expect, test } from "bun:test";
import { detectGoogle } from "./google.ts";
import { TokenManager, googleTokenProviders } from "./token.ts";

const enabled = process.env.DEVCTL_GOOGLE_INTEGRATION_TESTS === "1";

describe.skipIf(!enabled)("Google integration", () => {
  test("ADC can mint a user token", async () => {
    const st = await detectGoogle("");
    expect(st.adcAvailable).toBe(true);
    const tokens = new TokenManager(0, googleTokenProviders());
    const tok = await tokens.get("user", "", []);
    expect(tok.accessToken.length).toBeGreaterThan(10);
  });

  test("permission failures are classified", async () => {
    const tokens = new TokenManager(0, googleTokenProviders());
    await expect(tokens.get("sa:missing-sa@example.com", "", [])).rejects.toBeDefined();
  });
});
