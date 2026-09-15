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

// Signals that terminate the process by default and are safe to intercept: we
// restore the terminal, then re-raise so the shell still sees the real exit
// status (128 + signal number).
const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"] as const;

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

function describeCrash(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  try {
    return String(reason);
  } catch {
    return "unknown error";
  }
}

// Installs every guard that can return the terminal to a sane state when the
// TUI goes down without reaching OpenTUI's own destroy() path: a normal exit,
// a termination signal, a fatal signal delivered to JS, an uncaught exception,
// or an unhandled rejection. It cannot catch a native Bun panic — that faults
// below the JS runtime — but it covers every softer failure that would
// otherwise leave the shell in raw mode / on the alternate screen.
export function installTerminalRestoreOnExit(
  proc: RestoreProcess = process as unknown as RestoreProcess,
  restore: (write?: SyncFdWriter) => void = restoreTerminalModes,
): void {
  if (installed) {
    return;
  }
  installed = true;

  proc.on("exit", () => restore());

  for (const signal of TERMINATION_SIGNALS) {
    const handler = (): void => {
      restore();
      // Drop our handler and re-raise so the default terminating action runs
      // and the exit status reflects the signal.
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
      // Runtime refuses a listener for this signal; nothing more to do.
    }
  }

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

  const onFatal = (reason: unknown): void => {
    restore();
    try {
      proc.stderr.write(`\ndevctl: TUI terminated unexpectedly\n${describeCrash(reason)}\n`);
    } catch {
      // stderr already gone
    }
    proc.exit(1);
  };
  proc.on("uncaughtException", (err) => onFatal(err));
  proc.on("unhandledRejection", (reason) => onFatal(reason));
}

// Test-only: lets a suite reset the one-shot install guard between cases.
export function resetTerminalRestoreForTests(): void {
  installed = false;
}
