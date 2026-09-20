import { describe, expect, test } from "bun:test";
import { envRefsIn, interpolateEnvRefs, interpolateEnvRefsProtectingToken, secretTemplateLabel } from "./env-ref.ts";

describe("env refs", () => {
  test("finds ${NAME} and ${env.NAME}", () => {
    expect(envRefsIn("plain")).toEqual([]);
    expect(envRefsIn("${IAP_OAUTH_CLIENT_SECRET}")).toEqual(["IAP_OAUTH_CLIENT_SECRET"]);
    expect(envRefsIn("${env.HOME}")).toEqual(["HOME"]);
    expect(envRefsIn("pre-${A}-mid-${env.B}")).toEqual(["A", "B"]);
  });

  test("does not treat ${services.api.port} as an env name", () => {
    expect(envRefsIn("${services.api.port}")).toEqual([]);
  });

  test("interpolates from the provided env map", () => {
    expect(interpolateEnvRefs("${IAP_OAUTH_CLIENT_SECRET}", { IAP_OAUTH_CLIENT_SECRET: "from-env" })).toEqual({
      value: "from-env",
      missing: [],
    });
    expect(interpolateEnvRefs("${env.HOME}", { HOME: "/tmp" }).value).toBe("/tmp");
  });

  test("records empty or absent names without leaking other values", () => {
    expect(interpolateEnvRefs("${MISSING}", {})).toEqual({ value: "", missing: ["MISSING"] });
    expect(interpolateEnvRefs("${EMPTY}", { EMPTY: "" })).toEqual({ value: "", missing: ["EMPTY"] });
  });

  test("interpolateEnvRefsProtectingToken substitutes ${token} after env refs", () => {
    expect(interpolateEnvRefsProtectingToken("Bearer ${token}", {}, "jwt")).toEqual({ value: "Bearer jwt", missing: [] });
    expect(interpolateEnvRefsProtectingToken("k=${env.API_KEY} t=${token}", { API_KEY: "secret" }, "jwt")).toEqual({
      value: "k=secret t=jwt",
      missing: [],
    });
    expect(interpolateEnvRefsProtectingToken("Bearer ${token}", {}).value).toBe("Bearer ${token}");
    expect(interpolateEnvRefsProtectingToken("${env.MISSING} ${token}", {}, "jwt").missing).toEqual(["MISSING"]);
  });

  test("secretTemplateLabel exposes env templates and hides literals", () => {
    expect(secretTemplateLabel("")).toBeUndefined();
    expect(secretTemplateLabel("inline-secret")).toBeUndefined();
    expect(secretTemplateLabel("${IAP_OAUTH_CLIENT_SECRET}")).toBe("${IAP_OAUTH_CLIENT_SECRET}");
    expect(secretTemplateLabel("${env.HOME}")).toBe("${env.HOME}");
  });
});
