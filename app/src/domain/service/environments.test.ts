import { describe, expect, test } from "bun:test";
import { emptyService } from "../config/types.ts";
import {
  allServiceEnvConfigs,
  defaultEnvironmentName,
  effectiveServiceEnv,
  namedEnvironmentNames,
  overlayEnv,
  resolveEnvironmentName,
  serviceHasNamedEnvironments,
} from "./environments.ts";

function serviceWithEnvs() {
  const svc = emptyService();
  svc.environment = {
    vars: { SHARED: "base", AUTH_URL: "http://local" },
    required: ["AUTH_URL"],
    defaults: { LOG_LEVEL: "INFO" },
  };
  svc.environments = {
    deployed: {
      vars: { AUTH_URL: "https://identity.dev.example.com", REGION: "eu" },
      required: ["REGION"],
      defaults: { LOG_LEVEL: "WARN" },
    },
    local: {
      vars: { AUTH_URL: "http://127.0.0.1:18001" },
      required: [],
      defaults: {},
    },
  };
  svc.default_environment = "local";
  return svc;
}

describe("service named environments", () => {
  test("overlay unions required and lets the named set win on vars/defaults", () => {
    const merged = overlayEnv(
      { vars: { A: "1", B: "2" }, required: ["A"], defaults: { LOG: "info" } },
      { vars: { B: "3" }, required: ["B"], defaults: { LOG: "debug" } },
    );
    expect(merged.vars).toEqual({ A: "1", B: "3" });
    expect(merged.defaults).toEqual({ LOG: "debug" });
    expect(merged.required).toEqual(["A", "B"]);
  });

  test("names sort alphabetically and default_environment wins when valid", () => {
    const svc = serviceWithEnvs();
    expect(namedEnvironmentNames(svc)).toEqual(["deployed", "local"]);
    expect(defaultEnvironmentName(svc)).toBe("local");
    expect(serviceHasNamedEnvironments(svc)).toBe(true);
  });

  test("missing default_environment falls back to the first name alphabetically", () => {
    const svc = serviceWithEnvs();
    svc.default_environment = "";
    expect(defaultEnvironmentName(svc)).toBe("deployed");
    svc.default_environment = "missing";
    expect(defaultEnvironmentName(svc)).toBe("deployed");
  });

  test("resolveEnvironmentName keeps a valid selection and rejects unknown names", () => {
    const svc = serviceWithEnvs();
    expect(resolveEnvironmentName(svc, "deployed")).toBe("deployed");
    expect(resolveEnvironmentName(svc, "nope")).toBe("local");
    expect(resolveEnvironmentName(svc)).toBe("local");
  });

  test("effectiveServiceEnv applies the selected overlay on top of base", () => {
    const svc = serviceWithEnvs();
    const local = effectiveServiceEnv(svc, "local");
    expect(local.vars.AUTH_URL).toBe("http://127.0.0.1:18001");
    expect(local.vars.SHARED).toBe("base");
    expect(local.required).toEqual(["AUTH_URL"]);
    const deployed = effectiveServiceEnv(svc, "deployed");
    expect(deployed.vars.AUTH_URL).toBe("https://identity.dev.example.com");
    expect(deployed.vars.REGION).toBe("eu");
    expect(deployed.defaults.LOG_LEVEL).toBe("WARN");
    expect(deployed.required).toEqual(["AUTH_URL", "REGION"]);
  });

  test("allServiceEnvConfigs includes base and every named overlay", () => {
    const svc = serviceWithEnvs();
    const all = allServiceEnvConfigs(svc);
    expect(all).toHaveLength(3);
    expect(all.some((env) => env.vars.AUTH_URL === "http://local")).toBe(true);
    expect(all.some((env) => env.vars.AUTH_URL === "https://identity.dev.example.com")).toBe(true);
  });

  test("a service without named environments keeps base-only resolution", () => {
    const svc = emptyService();
    svc.environment.vars.TOKEN = "x";
    expect(namedEnvironmentNames(svc)).toEqual([]);
    expect(resolveEnvironmentName(svc, "local")).toBe("");
    expect(effectiveServiceEnv(svc).vars.TOKEN).toBe("x");
  });
});
