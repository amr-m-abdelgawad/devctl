import { afterEach, describe, expect, test } from "bun:test";
import {
  installTerminalRestoreOnExit,
  resetTerminalRestoreForTests,
  restoreTerminalModes,
  TERMINAL_RESTORE_SEQUENCE,
  type RestoreProcess,
} from "./terminal-restore.ts";

type Listener = (...args: unknown[]) => void;

function fakeProcess() {
  const listeners = new Map<string, Listener[]>();
  const stderrChunks: string[] = [];
  const killed: Array<{ pid: number; signal: string }> = [];
  const exits: number[] = [];
  const proc: RestoreProcess = {
    pid: 4242,
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return proc;
    },
    removeListener(event, listener) {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((l) => l !== listener),
      );
      return proc;
    },
    kill(pid, signal) {
      killed.push({ pid, signal });
    },
    exit(code) {
      exits.push(code ?? 0);
    },
    stderr: { write: (chunk: string) => stderrChunks.push(chunk) },
  };
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener(...args);
    }
  };
  return { proc, listeners, stderrChunks, killed, exits, emit };
}

afterEach(() => resetTerminalRestoreForTests());

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

describe("terminal restore guards", () => {
  test("registers exit and crash guards, not termination or uncaught errors", () => {
    const { proc, listeners } = fakeProcess();
    installTerminalRestoreOnExit(proc, () => {});
    expect(listeners.has("exit")).toBe(true);
    expect(listeners.has("SIGSEGV")).toBe(true);
    expect(listeners.has("SIGTERM")).toBe(false);
    expect(listeners.has("SIGHUP")).toBe(false);
    expect(listeners.has("SIGINT")).toBe(false);
    expect(listeners.has("uncaughtException")).toBe(false);
    expect(listeners.has("unhandledRejection")).toBe(false);
  });

  test("restores the terminal on a normal exit", () => {
    const { proc, emit } = fakeProcess();
    let restored = 0;
    installTerminalRestoreOnExit(proc, () => {
      restored += 1;
    });
    emit("exit");
    expect(restored).toBe(1);
  });

  test("restores then re-raises a crash signal", () => {
    const { proc, emit, killed } = fakeProcess();
    let restored = 0;
    installTerminalRestoreOnExit(proc, () => {
      restored += 1;
    });
    emit("SIGSEGV");
    expect(restored).toBe(1);
    expect(killed).toEqual([{ pid: 4242, signal: "SIGSEGV" }]);
  });

  test("only installs once", () => {
    const { proc, listeners } = fakeProcess();
    installTerminalRestoreOnExit(proc, () => {});
    installTerminalRestoreOnExit(proc, () => {});
    expect((listeners.get("exit") ?? []).length).toBe(1);
  });
});
