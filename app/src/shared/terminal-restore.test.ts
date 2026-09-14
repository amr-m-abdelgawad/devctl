import { describe, expect, test } from "bun:test";
import { restoreTerminalModes, TERMINAL_RESTORE_SEQUENCE } from "./terminal-restore.ts";

describe("terminal restore", () => {
  test("disables mouse tracking, alternate screen, and kitty keyboard", () => {
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[?1003l");
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[?1000l");
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[?1049l");
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[?25h");
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[<u");
  });

  test("writes the sequence to stdout and stderr even if one fd throws", () => {
    const fds: number[] = [];
    restoreTerminalModes((fd, data) => {
      fds.push(fd);
      if (fd === 1) {
        throw new Error("EPIPE");
      }
      expect(data.includes(0x1b)).toBe(true);
      return data.length;
    });
    expect(fds).toEqual([1, 2]);
  });
});
