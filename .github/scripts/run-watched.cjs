#!/usr/bin/env node
"use strict";

// Runs a command and stops it if it is still going after a limit, after
// printing what was running: every process started since the command began,
// the command's threads, and their native stacks where a debugger is
// installed. A test run that hangs then ends with the evidence in its log,
// instead of running silently into the job's own limit.
//
// usage: node run-watched.cjs <limit-minutes> <command> [args...]

const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

// What timeout(1) exits with.
const TIMED_OUT = 124;
const WINDOWS_CDB = "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe";

const limitMinutes = Number(process.argv[2]);
// A `--` before the command is accepted and not needed.
const command = process.argv.slice(process.argv[3] === "--" ? 4 : 3);
if (!(limitMinutes > 0) || command.length === 0) {
  console.error("usage: node run-watched.cjs <limit-minutes> <command> [args...]");
  process.exit(2);
}
const label = command.join(" ");
const windows = process.platform === "win32";

// Its own process group off Windows, so the whole of it can be stopped.
const child = spawn(command[0], command.slice(1), { stdio: "inherit", detached: !windows });
let limitReached = false;

child.on("error", (err) => {
  console.error(`could not run ${label}: ${err.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (limitReached) {
    return;
  }
  clearTimeout(timer);
  if (signal) {
    console.error(`${label} was stopped by ${signal}`);
  }
  process.exit(code ?? 1);
});

const timer = setTimeout(() => {
  limitReached = true;
  console.log(`::error::${label} was still running after ${limitMinutes} minutes and was stopped. Its log shows what was running.`);
  if (windows) {
    reportWindows(child.pid);
  } else {
    reportPosix(child.pid);
  }
  stop(child.pid);
  process.exit(TIMED_OUT);
}, limitMinutes * 60_000);

function section(title, body) {
  console.log(`::group::${title}`);
  try {
    body();
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
  console.log("::endgroup::");
}

function show(file, args, timeoutMs) {
  const result = spawnSync(file, args, { stdio: "inherit", timeout: timeoutMs });
  if (result.error) {
    console.log(`${file}: ${result.error.message}`);
  }
}

function powershell(lines, timeoutMs) {
  const script = ["$ProgressPreference = 'SilentlyContinue'", ...lines].join("\n");
  show("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], timeoutMs);
}

function reportWindows(pid) {
  // A child that started when the output stopped is what the run waits on.
  section("Processes started since the run began, oldest first", () => {
    powershell(
      [
        "$all = Get-CimInstance Win32_Process",
        `$root = $all | Where-Object { $_.ProcessId -eq ${pid} }`,
        "$since = if ($root) { $root.CreationDate.AddSeconds(-2) } else { (Get-Date).AddMinutes(-30) }",
        "$now = Get-Date",
        `if (-not $root) { 'pid ${pid} is gone; showing the last 30 minutes' }`,
        "'    pid    ppid   age s  command line'",
        "$all | Where-Object { $_.CreationDate -ge $since } | Sort-Object CreationDate | ForEach-Object {",
        "  $line = if ($_.CommandLine) { $_.CommandLine } else { $_.Name }",
        "  if ($line.Length -gt 400) { $line = $line.Substring(0, 400) + ' ...' }",
        "  '{0,7} {1,7} {2,7}  {3}' -f $_.ProcessId, $_.ParentProcessId, [int]($now - $_.CreationDate).TotalSeconds, $line",
        "}",
      ],
      60_000,
    );
  });
  // Busy or waiting: a thread that burns CPU is spinning, one in Wait is blocked.
  section(`Threads of pid ${pid}, oldest first`, () => {
    powershell(
      [
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
        `if (-not $p) { 'pid ${pid} is gone'; exit }`,
        "$before = $p.TotalProcessorTime.TotalMilliseconds",
        "Start-Sleep -Seconds 2",
        "$p.Refresh()",
        "'cpu over 2 s: {0:N0} ms   threads: {1}   handles: {2}   working set: {3:N0} MiB' -f ($p.TotalProcessorTime.TotalMilliseconds - $before), $p.Threads.Count, $p.HandleCount, ($p.WorkingSet64 / 1MB)",
        "'thread id  state     wait reason          cpu ms'",
        "$p.Threads | Sort-Object StartTime | Select-Object -First 64 | ForEach-Object {",
        "  $reason = ''",
        "  $cpu = 0",
        "  try { if ($_.ThreadState -eq 'Wait') { $reason = $_.WaitReason } } catch { }",
        "  try { $cpu = $_.TotalProcessorTime.TotalMilliseconds } catch { }",
        "  '{0,9}  {1,-8}  {2,-18} {3,8:N0}' -f $_.Id, $_.ThreadState, $reason, $cpu",
        "}",
      ],
      60_000,
    );
  });
  section(`Native stacks of pid ${pid}`, () => {
    if (!existsSync(WINDOWS_CDB)) {
      console.log(`no debugger at ${WINDOWS_CDB}`);
      return;
    }
    // Attached without stopping the process for good; it resumes on detach.
    show(WINDOWS_CDB, ["-pv", "-p", String(pid), "-c", "~*kn 24; qd"], 120_000);
  });
}

function reportPosix(pid) {
  section(`Processes in the group of pid ${pid}`, () => {
    const listed = spawnSync("ps", ["-eo", "pid,ppid,pgid,etime,stat,args"], { encoding: "utf8", timeout: 30_000 });
    const lines = (listed.stdout ?? "").split("\n");
    console.log(lines[0] ?? "");
    for (const line of lines.slice(1)) {
      const [own, parent, group] = line.trim().split(/\s+/).map(Number);
      if (own === pid || parent === pid || group === pid) {
        console.log(line);
      }
    }
  });
}

function stop(pid) {
  if (windows) {
    show("taskkill", ["/PID", String(pid), "/T", "/F"], 30_000);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}
