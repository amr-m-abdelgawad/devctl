import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { resolveEnvironment, runtimeForService } from "./environment.ts";

describe("environment precedence", () => {
  test("runtime overrides dotenv and service defaults", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-env-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env"), "FROM_DOTENV=a\nSHARED=dotenv\n");
    const svc = emptyService();
    svc.environment.defaults = { SHARED: "default", FROM_DEFAULT: "d" };
    svc.environment.vars = { SHARED: "svc" };
    const env = await resolveEnvironment(dir, {
      service: "api",
      profile: "",
      serviceCfg: svc,
      profileEnv: { SHARED: "profile" },
      assignedPorts: { http: 9000 },
      runtime: { SERVICE_PORT: "9000", SHARED: "runtime" },
    });
    expect(env.FROM_DOTENV).toBe("a");
    expect(env.FROM_DEFAULT).toBe("d");
    expect(env.SHARED).toBe("runtime");
    expect(env.SERVICE_PORT).toBe("9000");
  });

  test("resolves profile environment refs", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-env-ref-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    const svc = emptyService();
    const full = defaultConfig();
    full.services.auth = emptyService();
    full.services.auth.ports = [{ name: "http", value: 8001, auto: false }];
    full.services.api = svc;
    const env = await resolveEnvironment(dir, {
      service: "api",
      profile: "dev",
      serviceCfg: svc,
      profileEnv: { AUTH_URL: "http://127.0.0.1:${services.auth.ports.http}" },
      assignedPorts: {},
      runtime: {},
      cfg: full,
    });
    expect(env.AUTH_URL).toBe("http://127.0.0.1:8001");
  });

  test("secret_manager source uses injected values", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-env-sm-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    const svc = emptyService();
    const env = await resolveEnvironment(dir, {
      service: "api",
      profile: "",
      serviceCfg: svc,
      profileEnv: {},
      assignedPorts: {},
      runtime: {},
      sourceValues: { secret_manager: { DB_PASS: "s3cret" } },
    });
    expect(env.DB_PASS).toBe("s3cret");
  });

  test("the process layer prefers a supplied clientEnv over the real process.env", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-env-client-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    const svc = emptyService();
    const originalMarker = process.env.DEVCTL_TEST_CLIENT_ENV_MARKER;
    process.env.DEVCTL_TEST_CLIENT_ENV_MARKER = "from-real-process-env";
    try {
      const withClientEnv = await resolveEnvironment(dir, {
        service: "api",
        profile: "",
        serviceCfg: svc,
        profileEnv: {},
        assignedPorts: {},
        runtime: {},
        clientEnv: { DEVCTL_TEST_CLIENT_ENV_MARKER: "from-client" },
      });
      expect(withClientEnv.DEVCTL_TEST_CLIENT_ENV_MARKER).toBe("from-client");

      const withoutClientEnv = await resolveEnvironment(dir, {
        service: "api",
        profile: "",
        serviceCfg: svc,
        profileEnv: {},
        assignedPorts: {},
        runtime: {},
      });
      expect(withoutClientEnv.DEVCTL_TEST_CLIENT_ENV_MARKER).toBe("from-real-process-env");
    } finally {
      if (originalMarker === undefined) {
        delete process.env.DEVCTL_TEST_CLIENT_ENV_MARKER;
      } else {
        process.env.DEVCTL_TEST_CLIENT_ENV_MARKER = originalMarker;
      }
    }
  });

  test("runtimeForService sets SERVICE_PORT from http", () => {
    const env = runtimeForService("api", "127.0.0.1", { http: 8080, grpc: 9090 }, "http://127.0.0.1:18080", "dev");
    expect(env.SERVICE_PORT).toBe("8080");
    expect(env.HTTP_PORT).toBe("8080");
    expect(env.GRPC_PORT).toBe("9090");
    expect(env.DEVCTL_PROXY_URL).toBe("http://127.0.0.1:18080");
  });
});
