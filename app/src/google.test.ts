import { describe, expect, test } from "bun:test";
import { classifyGoogle, COMMAND_PROBE_MS, hasCommand } from "./google.ts";

describe("google probes", () => {
  test("hasCommand returns false quickly for a missing binary", async () => {
    const started = Date.now();
    expect(await hasCommand("devctl-missing-binary-9f3c2")).toBe(false);
    expect(Date.now() - started).toBeLessThan(COMMAND_PROBE_MS);
  });
});

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
});
