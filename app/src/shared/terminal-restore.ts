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

// Crash signals. A hard Bun/JSC panic prints its own report and exits before
// these ever reach JS, so intercepting them cannot rescue that case. We still
// register them best-effort: if a fault is ever delivered to the JS runtime
// (e.g. a native addon raising SIGABRT), we get one chance to un-raw the
// terminal before the process dies. Registration is guarded because some
// runtimes refuse a listener on these.
const CRASH_SIGNALS = ["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE"] as const;

// Minimal surface of `process` we depend on, so the guards can be unit tested
// against a fake without touching the real runtime.
export interface RestoreProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(pid: number, signal: string): void;
  exit(code?: number): void;
  pid: number;
  stderr: { write(chunk: string): unknown };
}

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

// Last-chance restore when OpenTUI never finishes destroy(): process exit, and
// a crash signal delivered to JS. SIGINT, SIGTERM, SIGHUP, and SIGQUIT are
// owned by the TUI so it can close the supervisor before destroy(). Uncaught
// exceptions take that same path. This cannot catch a native Bun panic.
export function installTerminalRestoreOnExit(
  proc: RestoreProcess = process as unknown as RestoreProcess,
  restore: (write?: SyncFdWriter) => void = restoreTerminalModes,
): void {
  if (installed) {
    return;
  }
  installed = true;

  proc.on("exit", () => restore());

  for (const signal of CRASH_SIGNALS) {
    const handler = (): void => {
      restore();
      try {
        proc.removeListener(signal, handler as (...args: unknown[]) => void);
        proc.kill(proc.pid, signal);
      } catch {
        proc.exit(1);
      }
    };
    try {
      proc.on(signal, handler as (...args: unknown[]) => void);
    } catch {
      // Best effort only; a hard panic never reaches here anyway.
    }
  }
}

// Test-only: lets a suite reset the one-shot install guard between cases.
export function resetTerminalRestoreForTests(): void {
  installed = false;
}
