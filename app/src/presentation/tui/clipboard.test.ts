import { describe, expect, test } from "bun:test";
import { availableClipboardCommands, clipboardCommands, clipboardUnavailableHint, osc52Sequence, writeClipboard } from "./clipboard.ts";

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

  test("available helpers are a subset of the platform list", () => {
    const available = availableClipboardCommands();
    const allowed = new Set(clipboardCommands().map((cmd) => cmd.join(" ")));
    for (const cmd of available) {
      expect(allowed.has(cmd.join(" "))).toBe(true);
    }
  });

  test("writeClipboard throws a hinted error when every helper fails", async () => {
    const original = Bun.which;
    Bun.which = () => null;
    const originalWrite = Bun.write;
    Bun.write = (async () => {
      throw new Error("no tty");
    }) as typeof Bun.write;
    const originalStderr = process.stderr.write;
    process.stderr.write = (() => false) as typeof process.stderr.write;
    try {
      await expect(writeClipboard("hi")).rejects.toThrow(/clipboard unavailable/);
    } finally {
      Bun.which = original;
      Bun.write = originalWrite;
      process.stderr.write = originalStderr;
    }
  });

  test("osc52 payload is base64 for the terminal", () => {
    const seq = osc52Sequence("hello");
    expect(seq.startsWith("\x1b]52;c;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
    expect(seq).toContain(Buffer.from("hello", "utf8").toString("base64"));
  });
});
