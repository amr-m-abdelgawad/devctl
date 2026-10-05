"use strict";

// Run with Bun on a Windows runner. Times the synchronous process calls
// devctl makes there against children that outlive their time limit, so a
// hung test run can be read against what this machine does: whether a timed
// out spawnSync returns, and whether a grandchild that keeps the pipes open
// holds it back.
//
// Temporary: remove this and its CI step once the Windows test hang is explained.

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const LONG_SECONDS = 20;
// Where run-watched.cjs looks for the debugger, then where else one may be.
const DEBUGGERS = [
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
  "C:\\Program Files\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
];

function describe(result) {
  const parts = [`status=${result.status}`, `signal=${result.signal}`];
  if (result.error) {
    parts.push(`error=${result.error.code ?? result.error.message}`);
  }
  const out = result.stdout ? String(result.stdout).trim().split(/\r?\n/)[0] : "";
  if (out) {
    parts.push(`stdout=${JSON.stringify(out.slice(0, 80))}`);
  }
  return parts.join(" ");
}

function timed(name, run) {
  const started = Date.now();
  let outcome;
  try {
    outcome = run();
  } catch (err) {
    outcome = `threw ${err.code ?? err.message}`;
  }
  console.log(`${String(Date.now() - started).padStart(6)} ms  ${name}: ${outcome}`);
}

function killCheck(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return `throws ${err.code ?? err.message}`;
  }
}

console.log(`bun ${process.versions.bun ?? "(not bun)"} on ${process.platform} ${process.arch}, pid ${process.pid}`);
if (process.platform !== "win32") {
  console.log("not Windows: nothing to probe");
  process.exit(0);
}

// Known before a hang, not after: whether a hung run would come with native stacks.
console.log(`bun at ${process.execPath}`);
for (const path of DEBUGGERS) {
  console.log(`debugger ${existsSync(path) ? "found" : "missing"} at ${path}`);
}
timed("where cdb", () => describe(spawnSync("where.exe", ["cdb"], { encoding: "utf8", timeout: 5_000 })));

console.log("\nA 1 s limit against a child that runs for 20 s. A call that honors its limit returns in about 1000 ms.");
// The process stamp read's shape: a direct child with its output piped.
timed("direct child, piped", () =>
  describe(spawnSync("powershell.exe", ["-NoProfile", "-Command", `Start-Sleep ${LONG_SECONDS}`], { encoding: "utf8", timeout: 1_000 })),
);
// The tasklist call's shape: cmd.exe is the child, and what it runs keeps the pipes after cmd.exe is killed.
timed("grandchild keeps the pipes", () =>
  describe(spawnSync("cmd.exe", ["/d", "/c", `ping -n ${LONG_SECONDS} 127.0.0.1`], { encoding: "buffer", windowsHide: true, timeout: 1_000 })),
);
// The lock's socket probe's shape: no pipes at all.
timed("direct child, no pipes", () =>
  describe(spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, BUN_BE_BUN: "1" }, stdio: "ignore", timeout: 500 })),
);
spawnSync("taskkill", ["/IM", "PING.EXE", "/F"], { stdio: "ignore", timeout: 5_000 });

console.log("\nThe real calls, for how long each takes here.");
const stamp = (pid) => ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`];
const tasklist = (pid) => ["/d", "/c", `tasklist /FO CSV /NH /FI "PID eq ${pid}"`];
timed("stamp read, first", () => describe(spawnSync("powershell.exe", stamp(process.pid), { encoding: "utf8", timeout: 10_000 })));
timed("stamp read, second", () => describe(spawnSync("powershell.exe", stamp(process.pid), { encoding: "utf8", timeout: 10_000 })));
timed("tasklist, live pid", () => describe(spawnSync("cmd.exe", tasklist(process.pid), { encoding: "utf8", windowsHide: true, timeout: 10_000 })));
timed("tasklist, no such pid", () => describe(spawnSync("cmd.exe", tasklist(4_194_300), { encoding: "utf8", windowsHide: true, timeout: 10_000 })));
timed("command line read", () =>
  describe(spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CommandLine`], { encoding: "utf8", timeout: 10_000 })),
);

console.log("\nSignal 0, which decides whether tasklist is asked at all.");
const child = Bun.spawn({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], env: { ...process.env, BUN_BE_BUN: "1" }, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
console.log(`  own running child ${child.pid}: ${killCheck(child.pid)}`);
child.kill();
child.exited.then(() => {
  console.log(`  the same child after it exited: ${killCheck(child.pid)}`);
  console.log(`  parent ${process.ppid}, not our child: ${killCheck(process.ppid)}`);
  console.log(`  pid 4, the System process: ${killCheck(4)}`);
  console.log(`  pid 4194300, no such process: ${killCheck(4_194_300)}`);
});
