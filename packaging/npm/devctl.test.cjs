"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  assertInstalledBun,
  assertSupportedTarget,
  launch,
  preserveChildExit,
  restoreTerminalAfterCrash,
  TERMINAL_RESTORE_SEQUENCE,
  resolveBunExecutable,
  targetFor,
} = require("./devctl.cjs");

test("target validation accepts supported systems and rejects unsupported systems", () => {
  assert.equal(targetFor("darwin", "arm64"), "darwin-arm64");
  assert.equal(assertSupportedTarget("linux", "x64"), "linux-x64");
  assert.throws(() => assertSupportedTarget("win32", "arm64"), /does not currently support win32-arm64/);
  assert.throws(() => assertSupportedTarget("freebsd", "x64"), /does not currently support freebsd-x64/);
});

test("Bun resolves relative to the installed package", () => {
  let request;
  let paths;
  const result = resolveBunExecutable((nextRequest, options) => {
    request = nextRequest;
    paths = options.paths;
    return "/runtime with spaces/bun.exe";
  });
  assert.equal(result, "/runtime with spaces/bun.exe");
  assert.equal(request, "bun/bin/bun.exe");
  assert.equal(paths.length, 1);
});

test("a missing Bun dependency produces an actionable error", () => {
  assert.throws(
    () => resolveBunExecutable(() => { throw new Error("module not found"); }),
    /bundled Bun runtime is missing.*without --ignore-scripts/i,
  );
});

test("disabled lifecycle scripts produce an actionable error", () => {
  assert.throws(
    () => assertInstalledBun("/fake/bun", () => Buffer.from("Error: Bun's postinstall script was not run.")),
    /Reinstall without --ignore-scripts/,
  );
});

test("cross-environment execution (Windows binary on Linux) produces an actionable error", () => {
  assert.throws(
    () => assertInstalledBun("/fake/bun.exe", () => Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "linux"),
    /devctl was installed for Windows.*running inside linux/i,
  );
});

test("launch forwards arguments, cwd, environment, and terminal streams without a shell", () => {
  const child = new EventEmitter();
  const calls = [];
  const env = { DEVCTL_TEST: "present" };
  const result = launch({
    platform: "linux",
    arch: "x64",
    argv: ["--config", "/repo with spaces/.devctl", "status"],
    cwd: "/repo with spaces",
    env,
    entrypoint: "/package with spaces/dist/devctl.js",
    resolveModule: () => "/runtime with spaces/bun.exe",
    readFile: () => Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    spawnChild(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(result, child);
  assert.deepEqual(calls, [
    {
      command: "/runtime with spaces/bun.exe",
      args: ["/package with spaces/dist/devctl.js", "--config", "/repo with spaces/.devctl", "status"],
      options: {
        cwd: "/repo with spaces",
        env,
        shell: false,
        stdio: "inherit",
        windowsHide: false,
      },
    },
  ]);
});

test("child exit codes and terminating signals are preserved", () => {
  const host = { exitCode: undefined, pid: 123, killCalls: [], kill(pid, signal) { this.killCalls.push([pid, signal]); } };
  preserveChildExit(host, 23, null);
  assert.equal(host.exitCode, 23);
  preserveChildExit(host, null, "SIGTERM");
  assert.deepEqual(host.killCalls, [[123, "SIGTERM"]]);
});

// Records synchronous fd writes so tests can assert the exact bytes and order.
function fakeSyncWriter() {
  const writes = [];
  const write = (fd, buffer) => {
    writes.push({ fd, text: buffer.toString() });
    return buffer.length;
  };
  return { writes, write };
}

test("terminal is restored to a TTY when the child dies from a fatal signal", () => {
  const sink = fakeSyncWriter();
  const targets = [{ fd: 1, isTTY: true }, { fd: 2, isTTY: true }];
  const wrote = restoreTerminalAfterCrash(null, "SIGSEGV", { targets, write: sink.write });
  assert.equal(wrote, true);
  assert.deepEqual(
    sink.writes,
    [{ fd: 1, text: TERMINAL_RESTORE_SEQUENCE }, { fd: 2, text: TERMINAL_RESTORE_SEQUENCE }],
  );
});

test("terminal is restored when the child exits with a crash code", () => {
  const sink = fakeSyncWriter();
  assert.equal(restoreTerminalAfterCrash(139, null, { targets: [{ fd: 1, isTTY: true }], write: sink.write }), true);
  assert.equal(sink.writes[0].text, TERMINAL_RESTORE_SEQUENCE);
});

test("a clean exit leaves the terminal untouched", () => {
  const sink = fakeSyncWriter();
  assert.equal(restoreTerminalAfterCrash(0, null, { targets: [{ fd: 1, isTTY: true }], write: sink.write }), false);
  assert.equal(sink.writes.length, 0);
});

test("non-TTY fds are never written to", () => {
  const sink = fakeSyncWriter();
  assert.equal(restoreTerminalAfterCrash(1, null, { targets: [{ fd: 1, isTTY: false }], write: sink.write }), false);
  assert.equal(sink.writes.length, 0);
});

test("a closed fd does not abort the restore of the others", () => {
  const sink = fakeSyncWriter();
  const write = (fd, buffer) => {
    if (fd === 1) {
      throw new Error("EBADF");
    }
    return sink.write(fd, buffer);
  };
  const targets = [{ fd: 1, isTTY: true }, { fd: 2, isTTY: true }];
  assert.equal(restoreTerminalAfterCrash(1, null, { targets, write }), true);
  assert.deepEqual(sink.writes, [{ fd: 2, text: TERMINAL_RESTORE_SEQUENCE }]);
});

test("the restore write is synchronous, so it completes before a re-raised signal", () => {
  // Reproduces the ordering runMain relies on: restore first, then the
  // signal re-raise. A synchronous writer means the bytes are already out
  // by the time kill() would fire, with no async flush to lose.
  const events = [];
  const write = (fd) => {
    events.push(`write:${fd}`);
    return 1;
  };
  const host = { pid: 123, kill(pid, signal) { events.push(`kill:${signal}`); } };

  restoreTerminalAfterCrash(null, "SIGSEGV", { targets: [{ fd: 1, isTTY: true }], write });
  preserveChildExit(host, null, "SIGSEGV");

  assert.deepEqual(events, ["write:1", "kill:SIGSEGV"]);
});
