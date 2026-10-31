import { describe, expect, test } from "bun:test";
import type { ClipboardWriteOptions, ClipboardWriteResult } from "@opentui/core";
import { clipboardFailureDetail, clipboardWriteSucceeded, writeClipboardText } from "./clipboard.ts";

function written(): ClipboardWriteResult {
  return {
    host: { status: "written" },
    terminal: { status: "not-attempted", capability: "unknown" },
  };
}

function remote(): ClipboardWriteResult {
  return {
    host: { status: "not-attempted" },
    terminal: { status: "attempted", capability: "unknown" },
  };
}

function failed(): ClipboardWriteResult {
  return {
    host: { status: "failed", error: new Error("no pasteboard") },
    terminal: { status: "local-failure", capability: "unsupported" },
  };
}

describe("clipboard", () => {
  test("treats a host write or a terminal OSC 52 attempt as success", () => {
    expect(clipboardWriteSucceeded(written())).toBe(true);
    expect(clipboardWriteSucceeded(remote())).toBe(true);
    expect(clipboardWriteSucceeded(failed())).toBe(false);
  });

  test("describes a failed host write", () => {
    expect(clipboardFailureDetail(failed())).toBe("no pasteboard");
  });

  test("writes with best-available", async () => {
    let destination: ClipboardWriteOptions["destination"] | undefined;
    await writeClipboardText(
      {
        writeText: async (_text, options) => {
          destination = options.destination;
          return written();
        },
      },
      "hello",
    );
    expect(destination).toBe("best-available");
  });

  test("accepts a terminal-only result from a remote session", async () => {
    await writeClipboardText(
      {
        writeText: async () => remote(),
      },
      "hello",
    );
  });

  test("throws a hinted error when every destination fails", async () => {
    await expect(
      writeClipboardText(
        {
          writeText: async () => failed(),
        },
        "hello",
      ),
    ).rejects.toThrow(/clipboard unavailable/);
  });

  test("wraps a rejected write", async () => {
    await expect(
      writeClipboardText(
        {
          writeText: async () => {
            throw new Error("closed");
          },
        },
        "hello",
      ),
    ).rejects.toThrow(/clipboard unavailable/);
  });
});
