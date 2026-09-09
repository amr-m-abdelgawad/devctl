import { Command } from "commander";
import { describe, expect, test } from "bun:test";
import type { ClientRuntime, Controller } from "../../application/client-runtime.ts";
import { defaultConfig } from "../../domain/config/types.ts";
import { addAuth } from "./auth.ts";

function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function stubRuntime(overrides: Partial<ClientRuntime> = {}): ClientRuntime {
  return {
    load: () => {
      const cfg = defaultConfig();
      cfg.google.project_id = "demo";
      return cfg;
    },
    detectGoogle: async () => ({
      gcloudInstalled: true,
      adcAvailable: true,
      userEmail: "me@example.com",
      projectID: "demo",
      projectSource: "config",
    }),
    loginGoogle: async () => {},
    logoutGoogle: async () => {},
    refreshUserToken: async () => ({ identity: "user", expiresAt: new Date("2026-01-01T00:00:00.000Z") }),
    openController: async () =>
      ({
        client: undefined,
        close: async () => {},
        refreshAuth: async () => ({
          user: "",
          project: "",
          project_source: "",
          adc: false,
          service_accounts: {},
          service_account_status: {},
          iap: false,
        }),
      }) as unknown as Controller,
    ...overrides,
  } as ClientRuntime;
}

async function parseAuth(runtime: ClientRuntime, args: string[]): Promise<string> {
  const root = new Command();
  root.option("-c, --config <path>");
  addAuth(root, runtime);
  const cap = captureStdout();
  try {
    await root.parseAsync(["node", "devctl", ...args], { from: "node" });
  } finally {
    cap.restore();
  }
  return cap.output();
}

describe("devctl auth", () => {
  test("status prints identity fields and JSON", async () => {
    const text = await parseAuth(stubRuntime(), ["auth", "status"]);
    expect(text).toContain("User:      me@example.com");
    expect(text).toContain("Project:   demo");
    expect(text).toContain("Source:    config");
    const json = await parseAuth(stubRuntime(), ["auth", "status", "--json"]);
    expect(JSON.parse(json)).toMatchObject({ userEmail: "me@example.com", projectID: "demo" });
  });

  test("status stays usable when config load fails", async () => {
    const out = await parseAuth(
      stubRuntime({
        load: () => {
          throw new Error("no config");
        },
        detectGoogle: async (project) => ({
          gcloudInstalled: false,
          adcAvailable: false,
          userEmail: "",
          projectID: project,
          projectSource: "",
        }),
      }),
      ["auth", "status"],
    );
    expect(out).toContain("User:      (unknown)");
    expect(out).toContain("Project:   (unset)");
  });

  test("login and logout call the runtime", async () => {
    const calls: string[] = [];
    const runtime = stubRuntime({
      loginGoogle: async () => {
        calls.push("login");
      },
      logoutGoogle: async () => {
        calls.push("logout");
      },
    });
    await parseAuth(runtime, ["auth", "login"]);
    await parseAuth(runtime, ["auth", "logout"]);
    expect(calls).toEqual(["login", "logout"]);
  });

  test("refresh reports the token and daemon service-account probes", async () => {
    let closed = false;
    const runtime = stubRuntime({
      openController: async () =>
        ({
          client: { close() {} },
          close: async () => {
            closed = true;
          },
          refreshAuth: async () => ({
            user: "me",
            project: "demo",
            project_source: "config",
            adc: true,
            service_accounts: {},
            service_account_status: { "sa@example.com": "available" },
            iap: false,
          }),
        }) as unknown as Controller,
    });
    const text = await parseAuth(runtime, ["auth", "refresh"]);
    expect(text).toContain("refreshed credentials expire 2026-01-01T00:00:00.000Z");
    expect(text).toContain("service account sa@example.com: available");
    expect(closed).toBe(true);
    const json = await parseAuth(runtime, ["auth", "refresh", "--json"]);
    expect(JSON.parse(json)).toMatchObject({
      identity: "user",
      service_account_status: { "sa@example.com": "available" },
    });
  });
});
