#!/usr/bin/env node
"use strict";

// Runs the unit suite several times in a row and counts how each run ended:
// passed, failed a test, crashed the runtime, or hung. For measuring a fault
// that shows up in one run out of several, under different runtime settings.
// Every run goes through run-watched.cjs, so a hung one is stopped and
// reported. Always exits 0: the counts are the result.
//
// Temporary: remove with windows-jit-probe.yml once the Windows crash is settled.
//
// usage: node repeat-tests.cjs <runs> <limit-minutes> [--env NAME=VALUE]... [--without-workers]
//   --env              set for each run, such as a BUN_JSC_ option
//   --without-workers  leave out the test files that start a worker thread

const { spawn } = require("node:child_process");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const args = process.argv.slice(2);
const runs = Number(args[0]);
const limitMinutes = Number(args[1]);
if (!(runs > 0) || !(limitMinutes > 0)) {
  console.error("usage: node repeat-tests.cjs <runs> <limit-minutes> [--env NAME=VALUE]... [--without-workers]");
  process.exit(2);
}
const env = { ...process.env };
let withoutWorkers = false;
for (let index = 2; index < args.length; index += 1) {
  if (args[index] === "--env") {
    const pair = args[index + 1] ?? "";
    env[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
    index += 1;
  } else if (args[index] === "--without-workers") {
    withoutWorkers = true;
  }
}

// What starts a worker thread in the test process itself.
const STARTS_WORKER = /new Worker\(|createDaemonLogStore\(|startEventLoopWatchdog\(|createDaemon\(|new WorkerLogStore\(/;

function testFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      testFiles(path, out);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const command = ["bun", "test"];
if (withoutWorkers) {
  const all = testFiles(".");
  const kept = all.filter((path) => !STARTS_WORKER.test(readFileSync(path, "utf8")));
  console.log(`leaving out ${all.length - kept.length} of ${all.length} test files that start a worker thread`);
  command.push(...kept.map((path) => `./${path.split("\\").join("/")}`));
}

function once() {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(__dirname, "run-watched.cjs"), String(limitMinutes), ...command], { env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const take = (chunk) => {
      process.stdout.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-200_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => {
      const seconds = Math.round((Date.now() - started) / 1000);
      const outcome = code === 0 ? "passed" : code === 124 ? "hung" : tail.includes("Bun has crashed") ? "crashed" : "failed a test";
      const where = /##\[group\]([^\n]*\.test\.tsx?):[^#]*$/.exec(tail)?.[1] ?? "";
      resolve({ outcome, seconds, where: outcome === "passed" ? "" : where });
    });
  });
}

(async () => {
  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    console.log(`::group::run ${run} of ${runs}`);
    const result = await once();
    console.log("::endgroup::");
    console.log(`run ${run}: ${result.outcome} after ${result.seconds} s${result.where ? ` in ${result.where}` : ""}`);
    results.push(result);
  }
  const count = (outcome) => results.filter((result) => result.outcome === outcome).length;
  const summary = `${runs} runs: ${count("passed")} passed, ${count("crashed")} crashed, ${count("hung")} hung, ${count("failed a test")} failed a test`;
  console.log(summary);
  console.log(`::notice::${summary}`);
})();
