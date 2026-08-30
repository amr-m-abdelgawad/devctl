import { spawn } from "bun";
import { processAlive } from "../storage.ts";
import type { ProcessIdentity } from "./unix.ts";

export async function killProcessTreeWindows(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (pid <= 0) {
    return;
  }
  const force = signal === "SIGKILL";
  const cmd = force
    ? ["taskkill", "/PID", String(pid), "/T", "/F"]
    : ["taskkill", "/PID", String(pid), "/T"];
  try {
    const proc = spawn({ cmd, stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    return;
  }
}

export async function inspectProcessWindows(pid: number): Promise<ProcessIdentity | undefined> {
  if (!processAlive(pid)) {
    return undefined;
  }
  try {
    const proc = spawn({
      cmd: ["wmic", "process", "where", `ProcessId=${pid}`, "get", "CommandLine,ExecutablePath", "/value"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = proc.stdout ? await new Response(proc.stdout).text() : "";
    await proc.exited;
    const command = pickValue(text, "CommandLine") || pickValue(text, "ExecutablePath");
    return { pid, command, cwd: "" };
  } catch {
    return { pid, command: "", cwd: "" };
  }
}

function pickValue(text: string, key: string): string {
  const prefix = `${key}=`;
  const line = text.split(/\r?\n/).find((row) => row.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}
