import { describe, expect, test } from "bun:test";
import { clipboardCommands, clipboardUnavailableHint, osc52Sequence } from "./clipboard.ts";

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

  test("linux candidates are optional packages plus a terminal fallback", () => {
    if (process.platform === "darwin" || process.platform === "win32") {
      return;
    }
    const bins = clipboardCommands().map((cmd) => cmd[0]);
    expect(bins).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(clipboardUnavailableHint()).toContain("wl-clipboard");
    expect(clipboardUnavailableHint()).toContain("xclip");
  });

  test("osc52 payload is base64 for the terminal", () => {
    const seq = osc52Sequence("hello");
    expect(seq.startsWith("\x1b]52;c;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
    expect(seq).toContain(Buffer.from("hello", "utf8").toString("base64"));
  });
});
