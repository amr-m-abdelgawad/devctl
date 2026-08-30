import { describe, expect, test } from "bun:test";
import { clipboardCommands } from "./clipboard.ts";

describe("clipboard", () => {
  test("picks a platform clipboard command", () => {
    const first = clipboardCommands()[0] ?? [];
    expect(first.length).toBeGreaterThan(0);
    if (process.platform === "darwin") {
      expect(first[0]).toBe("pbcopy");
    }
    if (process.platform === "win32") {
      expect(first[0]).toBe("clip");
    }
  });
});
