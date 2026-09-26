import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adcUserAccount, classifyGoogle, COMMAND_PROBE_MS, hasCommand } from "./google.ts";

describe("google probes", () => {
  test("hasCommand returns false quickly for a missing binary", async () => {
    const started = Date.now();
    expect(await hasCommand("devctl-missing-binary-9f3c2")).toBe(false);
    expect(Date.now() - started).toBeLessThan(COMMAND_PROBE_MS);
  });
});

describe("ADC authorized_user account", () => {
  test("reports a missing account, a present account, and a non-user key", () => {
    const missing = writeAdc({ type: "authorized_user", client_id: "c", refresh_token: "rt" });
    const present = writeAdc({ type: "authorized_user", account: " dev@example.com ", client_id: "c", refresh_token: "rt" });
    const serviceAccount = writeAdc({ type: "service_account", client_email: "sa@example.com" });
    const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    try {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = missing;
      expect(adcUserAccount()).toEqual({ state: "missing" });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = present;
      expect(adcUserAccount()).toEqual({ state: "present", account: "dev@example.com" });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccount;
      expect(adcUserAccount()).toEqual({ state: "other" });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = join(process.env.TMPDIR ?? "/tmp", "devctl-adc-missing.json");
      expect(adcUserAccount()).toEqual({ state: "absent" });
    } finally {
      if (previous === undefined) {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      } else {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
      }
      unlinkSync(missing);
      unlinkSync(present);
      unlinkSync(serviceAccount);
    }
  });
});

function writeAdc(body: Record<string, unknown>): string {
  const path = join(process.env.TMPDIR ?? "/tmp", `devctl-adc-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe("Google error classification", () => {
  test("disabled IAM Credentials API is not mislabeled as a role failure", () => {
    const error = classifyGoogle(new Error(
      "Permission denied: IAM Service Account Credentials API has not been used in project 123 before or it is disabled",
    ));
    expect(error.message).toContain("required Google API is not enabled");
    expect(error.message).not.toContain("cannot impersonate");
  });

  test("reads a disabled service reason from a structured Google response", () => {
    const error = classifyGoogle({
      message: "Google authentication failed",
      response: { data: { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } } },
    });
    expect(error.message).toContain("required Google API is not enabled");
  });

  test("reads getAccessToken permission denial from Google metadata", () => {
    const error = classifyGoogle({
      message: "Google authentication failed",
      response: {
        data: {
          error: {
            status: "PERMISSION_DENIED",
            details: [{ reason: "IAM_PERMISSION_DENIED", metadata: { permission: "iam.serviceAccounts.getAccessToken" } }],
          },
        },
      },
    });
    expect(error.message).toContain("cannot impersonate service account");
  });

  test("unauthorized_client is an IAP OAuth client mismatch, not a generic expired credential", () => {
    const error = classifyGoogle(new Error("unauthorized_client: The client is not authorized to request an ID token"));
    expect(error.message).toContain("IAP OAuth client does not match the ADC refresh token");
    expect(error.message).not.toContain("credential expired");
  });
});
