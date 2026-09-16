import { describe, expect, test } from "bun:test";
import { envNeedsRestart, noticeFor } from "./control.ts";

describe("web control notices", () => {
  test("set_service_environment reports the overlay and optional restart", () => {
    expect(noticeFor("set_service_environment", { restarted: false }, { service: "api", name: "deployed" })).toBe(
      "Switched api to deployed",
    );
    expect(noticeFor("set_service_environment", { restarted: true }, { service: "api", name: "local" })).toBe(
      "Switched api to local and restarted",
    );
  });

  test("envNeedsRestart is true only when a live process was started on another overlay", () => {
    expect(envNeedsRestart({ state: "RUNNING", env: "deployed", started_env: "local" })).toBe(true);
    expect(envNeedsRestart({ state: "RUNNING", env: "local", started_env: "local" })).toBe(false);
    expect(envNeedsRestart({ state: "STOPPED", env: "deployed", started_env: "local" })).toBe(false);
    expect(envNeedsRestart({ state: "RUNNING", env: "deployed" })).toBe(true);
    expect(envNeedsRestart({ state: "RUNNING" })).toBe(false);
  });
});
