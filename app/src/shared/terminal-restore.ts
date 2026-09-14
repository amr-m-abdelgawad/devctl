import { writeSync } from "node:fs";

// Any-event mouse (1003), button tracking (1002), X10 (1000), SGR (1006),
// urxvt (1015), SGR-pixels (1016), bracketed paste, alternate screen, cursor,
// Kitty keyboard. writeSync still works after process.exit / EPIPE, when
// OpenTUI never reached destroy() and the shell would otherwise keep receiving
// mouse CSI.
export const TERMINAL_RESTORE_SEQUENCE =
  "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1015l\x1b[?1016l" +
  "\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[<u\x1b[0m";

const STDOUT_FD = 1;
const STDERR_FD = 2;

export type SyncFdWriter = (fd: number, data: Uint8Array) => number;

let installed = false;

export function restoreTerminalModes(write: SyncFdWriter = writeSync): void {
  const buf = Buffer.from(TERMINAL_RESTORE_SEQUENCE);
  for (const fd of [STDOUT_FD, STDERR_FD]) {
    try {
      write(fd, buf);
    } catch {
      // fd already closed
    }
  }
}

export function installTerminalRestoreOnExit(): void {
  if (installed) {
    return;
  }
  installed = true;
  process.on("exit", () => restoreTerminalModes());
}
