import { describe, expect, test } from "bun:test";
import { HealthPolicy, RestartPolicy, StartupPolicy } from "./policies.ts";
import { emptyService, RestartAlways, RestartNever, RestartOnFailure } from "../config/types.ts";

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

describe("StartupPolicy", () => {
  test("uses the service timeout when set and falls back otherwise", () => {
    const timed = emptyService();
    timed.startup.timeout_seconds = 12;
    timed.startup.wait_for_healthy = true;
    expect(StartupPolicy.timeoutMs(timed, 30_000)).toBe(12_000);
    expect(StartupPolicy.waitForHealthy(timed)).toBe(true);
    expect(StartupPolicy.timeoutMs(emptyService(), 30_000)).toBe(30_000);
  });
});
