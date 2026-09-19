import { describe, expect, test } from "bun:test";
import { setupBootEmptyState } from "./Setup.tsx";

describe("setupBootEmptyState", () => {
  test("offers setup when no configuration exists", () => {
    expect(setupBootEmptyState({ bootError: "no config", bootErrorMissing: true })).toEqual({
      title: "No configuration found",
      body: "Would you like to run setup?",
      hint: "[Enter] 9-step setup   [Esc] Exit",
    });
  });

  test("tells the operator to fix YAML when load failed", () => {
    expect(
      setupBootEmptyState({
        bootError: "unknown field proxy.foo",
        bootErrorConfig: true,
      }),
    ).toEqual({
      title: "Configuration error",
      body: "unknown field proxy.foo",
      hint: "Fix .devctl/config.yaml, then restart devctl   [Esc] Exit",
    });
  });

  test("does not blame config.yaml when the supervisor failed to bind", () => {
    expect(
      setupBootEmptyState({
        bootError: "supervisor failed to start — unable to listen on 127.0.0.1:18418 (EADDRINUSE)",
      }),
    ).toEqual({
      title: "Supervisor failed to start",
      body: "supervisor failed to start — unable to listen on 127.0.0.1:18418 (EADDRINUSE)",
      hint: "A listen port is already in use, or the daemon crashed. See `devctl daemon logs`, then restart.   [Esc] Exit",
    });
  });

  test("is inactive when boot succeeded", () => {
    expect(setupBootEmptyState({})).toBeUndefined();
  });
});
