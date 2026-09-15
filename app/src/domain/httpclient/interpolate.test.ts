import { describe, expect, test } from "bun:test";
import { applyBrunoVars, interpolateHttpClient } from "./interpolate.ts";

describe("interpolateHttpClient", () => {
  test("resolves ${} first, then {{}} in a single pass each", () => {
    const out = interpolateHttpClient(
      "https://${services.api.host}/{{path}}",
      (value) => value.replaceAll("${services.api.host}", "127.0.0.1:3000"),
      { path: "health" },
    );
    expect(out).toBe("https://127.0.0.1:3000/health");
  });

  test("does not re-scan {{}} output for ${} refs", () => {
    const out = interpolateHttpClient(
      "Bearer {{stolen}}",
      (value) => value.replaceAll("${token}", "MINTED"),
      { stolen: "${token}" },
    );
    expect(out).toBe("Bearer ${token}");
    expect(out).not.toContain("MINTED");
  });

  test("leaves unknown {{vars}} intact", () => {
    expect(applyBrunoVars("{{missing}}/ok", { other: "x" })).toBe("{{missing}}/ok");
  });

  test("does not recursively expand vars in values", () => {
    expect(applyBrunoVars("{{foo}}", { foo: "{{bar}}", bar: "secret" })).toBe("{{bar}}");
  });
});
