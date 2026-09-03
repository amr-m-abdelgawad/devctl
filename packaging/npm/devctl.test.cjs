"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  assertInstalledBun,
  assertSupportedTarget,
  launch,
  preserveChildExit,
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
