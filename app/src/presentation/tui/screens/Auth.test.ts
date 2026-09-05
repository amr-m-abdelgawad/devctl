import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../../domain/config/types.ts";
import { serviceAccountRows } from "./Auth.tsx";

describe("Identity screen service accounts", () => {
  test("shows an account declared on an auth:none route as inactive", () => {
    const cfg = defaultConfig();
    cfg.proxy.routes.push({
      name: "public",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:3000" },
      auth: {
        type: "none",
        identity: { type: "service_account", service_account: "demo@example.com" },
        audience: "",
        service_account: "",
      },
    });

    expect(serviceAccountRows(cfg)).toEqual([{ email: "demo@example.com", inactive: true, ok: undefined }]);
  });

  test("keeps inactive declarations beside live active-account status", () => {
    const cfg = defaultConfig();
    cfg.proxy.routes.push({
      name: "public",
      match: { host: "", path: "" },
      upstream: { url: "http://127.0.0.1:3000" },
      auth: {
        type: "none",
        identity: { type: "service_account", service_account: "inactive@example.com" },
        audience: "",
        service_account: "",
      },
    });

    expect(
      serviceAccountRows(cfg, {
        user: "",
        project: "",
        project_source: "",
        adc: true,
        service_accounts: { "active@example.com": true },
        service_account_status: { "active@example.com": "available" },
        iap: false,
      }),
    ).toEqual([
      { email: "active@example.com", inactive: false, ok: true },
      { email: "inactive@example.com", inactive: true, ok: undefined },
    ]);
  });
});
