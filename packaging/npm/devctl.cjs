#!/usr/bin/env node
"use strict";

const { closeSync, openSync, readSync } = require("fs");
const { resolve } = require("path");
const { spawn } = require("child_process");

const SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);

function targetFor(platform, arch) {
  const p = platform !== undefined ? platform : process.platform;
  const a = arch !== undefined ? arch : process.arch;
  return `${p}-${a}`;
}

function assertSupportedTarget(platform, arch) {
  const p = platform !== undefined ? platform : process.platform;
  const a = arch !== undefined ? arch : process.arch;
  const target = targetFor(p, a);
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(
      `devctl does not currently support ${target}. Supported targets: ${Array.from(SUPPORTED_TARGETS).join(", ")}.`,
    );
  }
  return target;
}

function resolveBunExecutable(resolveModule) {
  const res = resolveModule !== undefined ? resolveModule : require.resolve;
  try {
    return res("bun/bin/bun.exe", { paths: [__dirname] });
  } catch (cause) {
    throw new Error(
      "The bundled Bun runtime is missing. Reinstall @amr-m-abdelgawad/devctl without --ignore-scripts and try again.",
    );
  }
}

function readFilePrefix(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const prefix = Buffer.alloc(512);
    const bytesRead = readSync(descriptor, prefix, 0, prefix.length, 0);
    return prefix.slice(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function assertInstalledBun(bunPath, readFile, platform) {
  const read = readFile !== undefined ? readFile : readFilePrefix;
  const targetPlatform = platform !== undefined ? platform : process.platform;
  let prefix;
  try {
    prefix = read(bunPath);
  } catch (_) {
    return;
  }
  const text = prefix.toString("utf8");
  if (text.includes("Bun's postinstall script was not run")) {
    throw new Error(
      "The bundled Bun runtime was not installed because npm lifecycle scripts were disabled. " +
        "Reinstall without --ignore-scripts, then run devctl again.",
    );
  }
  if (targetPlatform !== "win32" && prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a) {
    throw new Error(
      `devctl was installed for Windows (detected Windows binary at ${bunPath}), but is running inside ${targetPlatform}.\n` +
        "When running inside WSL or Linux, install Node.js natively in WSL and run: npm install --global @amr-m-abdelgawad/devctl\n" +
        "To run devctl in Windows, use PowerShell or Command Prompt instead.",
    );
  }
}

function launch(options) {
  const opts = options !== undefined ? options : {};
  const platform = opts.platform !== undefined ? opts.platform : process.platform;
  const arch = opts.arch !== undefined ? opts.arch : process.arch;
  const argv = opts.argv !== undefined ? opts.argv : process.argv.slice(2);
  const env = opts.env !== undefined ? opts.env : process.env;
  const cwd = opts.cwd !== undefined ? opts.cwd : process.cwd();
  const spawnChild = opts.spawnChild !== undefined ? opts.spawnChild : spawn;
  const resolveModule = opts.resolveModule !== undefined ? opts.resolveModule : require.resolve;
  const readFile = opts.readFile !== undefined ? opts.readFile : readFilePrefix;
  const entrypoint = opts.entrypoint !== undefined ? opts.entrypoint : resolve(__dirname, "../dist/devctl.js");

  assertSupportedTarget(platform, arch);
  const bunPath = resolveBunExecutable(resolveModule);
  assertInstalledBun(bunPath, readFile, platform);

  return spawnChild(bunPath, [entrypoint, ...argv], {
    cwd,
    env,
    shell: false,
    stdio: "inherit",
    windowsHide: false,
  });
}

// Mirror of TERMINAL_RESTORE_SEQUENCE in app/src/shared/terminal-restore.ts.
// This launcher is a standalone .cjs that cannot import the app's TypeScript,
// so the escape sequence is duplicated and kept in sync by hand.
const TERMINAL_RESTORE_SEQUENCE =
  "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1015l\x1b[?1016l" +
  "\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[<u\x1b[0m";

// When the Bun child dies abnormally — a native panic exits via a fatal signal
// (SIGSEGV/SIGABRT) or a non-zero code — OpenTUI never reached its own
// destroy(), so the terminal is left in raw mode and on the alternate screen.
// This parent process survives the child's crash, so it is the one place that
// can still un-raw the inherited TTY. A clean exit (code 0, no signal) means
// the TUI already restored the terminal itself, so we leave it alone.
function restoreTerminalAfterCrash(code, signal, streams) {
  const crashed = Boolean(signal) || (typeof code === "number" && code !== 0);
  if (!crashed) {
    return false;
  }
  const targets = streams !== undefined ? streams : [process.stdout, process.stderr];
  let wrote = false;
  for (const stream of targets) {
    if (stream && stream.isTTY && typeof stream.write === "function") {
      try {
        stream.write(TERMINAL_RESTORE_SEQUENCE);
        wrote = true;
      } catch (_) {
        // stream already closed
      }
    }
  }
  return wrote;
}

function preserveChildExit(hostProcess, code, signal) {
  if (typeof code === "number") {
    hostProcess.exitCode = code;
    return;
  }
  if (signal) {
    hostProcess.kill(hostProcess.pid, signal);
    return;
  }
  hostProcess.exitCode = 1;
}

function runMain() {
  let child;
  try {
    child = launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`devctl: ${message}`);
    process.exitCode = 1;
    return;
  }

  const forwardedSignals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map();
  for (const signal of forwardedSignals) {
    const handler = () => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  child.once("error", (error) => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    console.error(`devctl: failed to start the bundled Bun runtime: ${error.message}`);
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    for (const [registeredSignal, handler] of handlers) {
      process.off(registeredSignal, handler);
    }
    restoreTerminalAfterCrash(code, signal);
    preserveChildExit(process, code, signal);
  });
}

if (require.main === module) {
  runMain();
}

module.exports = {
  SUPPORTED_TARGETS,
  assertInstalledBun,
  assertSupportedTarget,
  launch,
  preserveChildExit,
  restoreTerminalAfterCrash,
  TERMINAL_RESTORE_SEQUENCE,
  readFilePrefix,
  resolveBunExecutable,
  targetFor,
};
