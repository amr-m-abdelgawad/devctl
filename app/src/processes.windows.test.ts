import { describe, expect, test } from "bun:test";
import { killProcessTreeWindows } from "./processes/windows.ts";

describe("windows process backend", () => {
  test("taskkill helper is defined", async () => {
    if (process.platform !== "win32") {
      expect(typeof killProcessTreeWindows).toBe("function");
      return;
    }
    await killProcessTreeWindows(0, "SIGTERM");
    expect(true).toBe(true);
  });
});
