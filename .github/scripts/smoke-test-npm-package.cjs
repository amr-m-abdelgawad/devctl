#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const tarballArgument = process.argv[2];
const expectedVersion = process.argv[3];
const mode = process.argv[4] ?? "local";
if (!tarballArgument || !expectedVersion || !new Set(["local", "global", "npx"]).has(mode)) {
  console.error("usage: node smoke-test-npm-package.cjs <package.tgz> <version> [local|global|npx]");
  process.exit(2);
}

const tarball = resolve(tarballArgument);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const root = mkdtempSync(join(tmpdir(), "devctl-npm-smoke-"));
const repository = join(root, "repo with spaces");
const config = join(repository, ".devctl", "config.yaml");
const home = join(root, "home");
let launcher;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    stdio: options.capture === false ? "inherit" : "pipe",
    timeout: options.timeout ?? 30_000,
    input: options.input,
  });
  if (options.capture !== false && options.quiet !== true) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  const accepted = options.acceptedExitCodes ?? [0];
  if (result.error) throw result.error;
  if (!accepted.includes(result.status)) {
    const details = options.quiet === true ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    throw new Error(`${basename(command)} ${args.join(" ")} exited ${String(result.status)}${details}`);
  }
  return result;
}

function runTool(command, args, options = {}) {
  if (process.platform === "win32" && command.endsWith(".cmd")) {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], options);
  }
  return run(command, args, options);
}

function testTuiInPseudoTerminal() {
  if (process.env.DEVCTL_TEST_TUI !== "1" || process.platform === "win32") return;
  run("python3", [resolve(__dirname, "tui-smoke.py"), launcher, config], {
    env: { ...process.env, DEVCTL_HOME: home, TERM: "xterm-256color" },
    timeout: 20_000,
  });
}

function devctl(args, options = {}) {
  const environment = {
    ...process.env,
    DEVCTL_HOME: home,
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...options.env,
  };
  if (mode === "npx") {
    return runTool(npxCommand, ["--yes", `file:${tarball}`, ...args], { ...options, env: environment });
  }
  if (process.platform === "win32" && launcher.endsWith(".cmd")) {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", launcher, ...args], {
      ...options,
      env: environment,
    });
  }
  return run(launcher, args, { ...options, env: environment });
}

function installPackage() {
  if (mode === "npx") {
    launcher = npxCommand;
    const version = devctl(["version"], { timeout: 180_000 });
    assert.match(version.stdout, new RegExp(`devctl ${expectedVersion.replaceAll(".", "\\.")}`));
    return;
  }
  if (mode === "global") {
    const prefix = join(root, "global prefix");
    runTool(npmCommand, ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball], { timeout: 180_000 });
    launcher = process.platform === "win32" ? join(prefix, "devctl.cmd") : join(prefix, "bin", "devctl");
    return;
  }

  writeFileSync(join(root, "package.json"), '{"name":"devctl-npm-smoke","private":true}\n');
  runTool(npmCommand, ["install", "--no-audit", "--no-fund", tarball], { timeout: 180_000 });
  launcher = join(root, "node_modules", ".bin", process.platform === "win32" ? "devctl.cmd" : "devctl");
  const npmExec = runTool(npmCommand, ["exec", "--", "devctl", "version"], { cwd: root });
  assert.match(npmExec.stdout, new RegExp(`devctl ${expectedVersion.replaceAll(".", "\\.")}`));
}

function packageRoot() {
  if (mode === "global") {
    const modules = process.platform === "win32" ? "node_modules" : join("lib", "node_modules");
    return join(root, "global prefix", modules, "@amr-m-abdelgawad", "devctl");
  }
  return join(root, "node_modules", "@amr-m-abdelgawad", "devctl");
}

function removeTemporaryRoot() {
  const retryable = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retryable.has(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  // Windows runners can retain a short-lived scanner or pipe handle after
  // the supervisor exits. The runner workspace is ephemeral, and cleanup
  // must not turn an otherwise successful end-to-end test into a failure.
  console.warn(`could not remove temporary smoke directory: ${root}`);
}

try {
  installPackage();
  if (mode !== "npx") {
    assert.ok(existsSync(launcher), `npm did not create the devctl launcher at ${launcher}`);
  }

  mkdirSync(dirname(config), { recursive: true });
  mkdirSync(home, { recursive: true });
  const serviceCommand = [process.execPath, "-e", "console.log('npm smoke ready'),setInterval(() => {},300000)"];
  writeFileSync(
    config,
    [
      "version: 1",
      "project:",
      "  name: npm-smoke",
      "shutdown:",
      "  stop_services_on_exit: true",
      "services:",
      "  ping:",
      `    command: ${JSON.stringify(serviceCommand)}`,
      "",
    ].join("\n"),
  );

  const version = devctl(["version"]);
  assert.match(version.stdout, new RegExp(`devctl ${expectedVersion.replaceAll(".", "\\.")}`));
  assert.match(devctl(["--help"]).stdout, /Local development orchestrator/);
  assert.match(devctl(["completion", "zsh"]).stdout, /devctl/);
  assert.match(devctl(["--config", config, "config", "validate"]).stdout, /configuration is valid/);
  devctl(["--config", config, "doctor", "--json"], { acceptedExitCodes: [0, 2] });

  if (mode !== "npx") {
    const installedRoot = packageRoot();
    const bunExecutable = require.resolve("bun/bin/bun.exe", { paths: [join(installedRoot, "bin")] });
    assert.ok(existsSync(bunExecutable), "the package-local Bun runtime is missing");
    run(bunExecutable, ["-e", "await import('@opentui/core'); console.log('OpenTUI loaded')"], { cwd: installedRoot });
    testTuiInPseudoTerminal();
  }

  devctl(["--config", config, "start", "ping"]);
  assert.match(devctl(["--config", config, "status"]).stdout, /ping\s+(RUNNING|HEALTHY)/);
  assert.match(devctl(["--config", config, "logs", "ping"]).stdout, /npm smoke ready/);
  const mcp = devctl(["--config", config, "mcp", "--on", "--json"]);
  assert.equal(JSON.parse(mcp.stdout).running, true);
  devctl(["--config", config, "mcp", "--off", "--json"]);
  devctl(["--config", config, "down"]);

  console.log(`npm ${mode} package smoke test passed on ${process.platform}-${process.arch}`);
} finally {
  if (launcher && existsSync(config)) {
    try {
      devctl(["--config", config, "down"], { acceptedExitCodes: [0, 1, 2, 3, 4, 5, 6], timeout: 10_000 });
    } catch {
      // Preserve the original test failure; the CI workspace is ephemeral.
    }
  }
  removeTemporaryRoot();
}
