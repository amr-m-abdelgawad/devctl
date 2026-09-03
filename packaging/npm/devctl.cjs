#!/usr/bin/env node
"use strict";

const { closeSync, openSync, readSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawn } = require("node:child_process");

const SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);

function targetFor(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function assertSupportedTarget(platform = process.platform, arch = process.arch) {
  const target = targetFor(platform, arch);
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(
      `devctl does not currently support ${target}. Supported targets: ${Array.from(SUPPORTED_TARGETS).join(", ")}.`,
    );
  }
  return target;
}

function resolveBunExecutable(resolveModule = require.resolve) {
  try {
    return resolveModule("bun/bin/bun.exe", { paths: [__dirname] });
  } catch (cause) {
    throw new Error(
      "The bundled Bun runtime is missing. Reinstall @amr-m-abdelgawad/devctl without --ignore-scripts and try again.",
      { cause },
    );
  }
}

function readFilePrefix(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const prefix = Buffer.alloc(512);
    const bytesRead = readSync(descriptor, prefix, 0, prefix.length, 0);
    return prefix.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function assertInstalledBun(bunPath, readFile = readFilePrefix) {
  const prefix = readFile(bunPath).toString("utf8");
  if (prefix.includes("Bun's postinstall script was not run")) {
    throw new Error(
      "The bundled Bun runtime was not installed because npm lifecycle scripts were disabled. " +
        "Reinstall without --ignore-scripts, then run devctl again.",
    );
  }
}

function launch(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const spawnChild = options.spawnChild ?? spawn;
  const resolveModule = options.resolveModule ?? require.resolve;
  const readFile = options.readFile ?? readFilePrefix;
  const entrypoint = options.entrypoint ?? resolve(__dirname, "../dist/devctl.js");

  assertSupportedTarget(platform, arch);
  const bunPath = resolveBunExecutable(resolveModule);
  assertInstalledBun(bunPath, readFile);

  return spawnChild(bunPath, [entrypoint, ...argv], {
    cwd,
    env,
    shell: false,
    stdio: "inherit",
    windowsHide: false,
  });
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
  readFilePrefix,
  resolveBunExecutable,
  targetFor,
};
