import { describe, expect, test } from "bun:test";
import { CredentialRefreshPolicy, HealthPolicy, RestartPolicy } from "./policies.ts";
import { RestartAlways, RestartNever, RestartOnFailure } from "../config/types.ts";

describe("RestartPolicy", () => {
  test("restarts on failure within budget", () => {
    expect(RestartPolicy.shouldRestart({
      policy: RestartOnFailure,
      enabled: true,
      exitCode: 1,
      retryCount: 0,
      maxRetries: 3,
    })).toBe(true);
  });

  test("does not restart a clean exit under on_failure", () => {
    expect(RestartPolicy.shouldRestart({
      policy: RestartOnFailure,
      enabled: true,
      exitCode: 0,
      retryCount: 0,
      maxRetries: 3,
    })).toBe(false);
  });

  test("honors never and exhausted retries", () => {
    expect(RestartPolicy.shouldRestart({
      policy: RestartNever,
      enabled: true,
      exitCode: 1,
      retryCount: 0,
      maxRetries: 3,
    })).toBe(false);
    expect(RestartPolicy.shouldRestart({
      policy: RestartAlways,
      enabled: true,
      exitCode: 0,
      retryCount: 3,
      maxRetries: 3,
    })).toBe(false);
  });
});

describe("HealthPolicy", () => {
  test("restarts after the unhealthy streak", () => {
    expect(HealthPolicy.shouldRestartUnhealthy(2, 3)).toBe(false);
    expect(HealthPolicy.shouldRestartUnhealthy(3, 3)).toBe(true);
  });
});

describe("CredentialRefreshPolicy", () => {
  test("refreshes when expiry is inside the threshold", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(CredentialRefreshPolicy.shouldRefresh(new Date("2026-01-01T00:04:00Z"), now, 5 * 60_000)).toBe(true);
    expect(CredentialRefreshPolicy.shouldRefresh(new Date("2026-01-01T01:00:00Z"), now, 5 * 60_000)).toBe(false);
  });
});
