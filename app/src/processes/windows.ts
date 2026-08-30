import { spawn } from "bun";
import { processAlive } from "../storage.ts";
import type { ProcessIdentity, ResourceSample } from "./unix.ts";

const BYTES_PER_KB = 1024;

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
  const cim = await capture([
    "powershell",
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CommandLine,ExecutablePath,CreationDate | ConvertTo-Json -Compress`,
  ]);
  const parsed = parseCimProcess(cim);
  if (parsed && parsed.command !== "") {
    return {
      pid,
      command: parsed.command,
      cwd: parsed.cwd,
      startTime: parsed.startTime,
    };
  }
  const fallback = await capture([
    "powershell",
    "-NoProfile",
    "-Command",
    `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Path,StartTime | ConvertTo-Json -Compress`,
  ]);
  const fromProcess = parseGetProcess(fallback);
  if (!fromProcess && !parsed) {
    return undefined;
  }
  return {
    pid,
    command: parsed?.command || fromProcess?.command || "",
    cwd: parsed?.cwd || fromProcess?.cwd || "",
    startTime: parsed?.startTime || fromProcess?.startTime,
  };
}

export function parseGetProcess(text: string): { command: string; cwd: string; startTime?: string } | undefined {
  const raw = text.trim();
  if (raw === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { Path?: string; StartTime?: string };
    const path = (parsed.Path || "").trim();
    if (path === "") {
      return undefined;
    }
    return { command: path, cwd: dirnameOf(path), startTime: parsed.StartTime };
  } catch {
    const path = pickValue(raw, "Path");
    if (path === "") {
      return undefined;
    }
    return { command: path, cwd: dirnameOf(path) };
  }
}

export function parseCimProcess(text: string): { command: string; cwd: string; startTime?: string } | undefined {
  const raw = text.trim();
  if (raw === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { CommandLine?: string; ExecutablePath?: string; CreationDate?: string };
    const command = (parsed.CommandLine || parsed.ExecutablePath || "").trim();
    const exe = (parsed.ExecutablePath || "").trim();
    const cwd = dirnameOf(exe);
    return { command, cwd, startTime: parsed.CreationDate || undefined };
  } catch {
    return {
      command: pickValue(raw, "CommandLine") || pickValue(raw, "ExecutablePath"),
      cwd: dirnameOf(pickValue(raw, "ExecutablePath")),
    };
  }
}

export async function sampleResourceUsageWindows(pids: number[]): Promise<Map<number, ResourceSample>> {
  const result = new Map<number, ResourceSample>();
  if (pids.length === 0) {
    return result;
  }
  const list = pids.filter((pid) => pid > 0).join(",");
  if (list === "") {
    return result;
  }
  const text = await capture([
    "powershell",
    "-NoProfile",
    "-Command",
    `${list}.Split(',') | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress`,
  ]);
  return parseWindowsResourceSamples(text);
}

export function parseWindowsResourceSamples(text: string): Map<number, ResourceSample> {
  const result = new Map<number, ResourceSample>();
  const raw = text.trim();
  if (raw === "") {
    return result;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const rec = row as { Id?: number; CPU?: number; WorkingSet64?: number };
      const pid = Number(rec.Id);
      const cpuPercent = Number(rec.CPU ?? 0);
      const memoryKB = Number(rec.WorkingSet64 ?? 0) / BYTES_PER_KB;
      if (Number.isFinite(pid) && pid > 0 && Number.isFinite(cpuPercent) && Number.isFinite(memoryKB)) {
        result.set(pid, { pid, cpuPercent, memoryKB });
      }
    }
  } catch {
    return result;
  }
  return result;
}

function dirnameOf(path: string): string {
  if (path === "") {
    return "";
  }
  const norm = path.replace(/\//g, "\\");
  const idx = norm.lastIndexOf("\\");
  return idx > 0 ? norm.slice(0, idx) : "";
}

function pickValue(text: string, key: string): string {
  const prefix = `${key}=`;
  const line = text.split(/\r?\n/).find((row) => row.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

async function capture(cmd: string[]): Promise<string> {
  try {
    const proc = spawn({ cmd, stdout: "pipe", stderr: "ignore" });
    const text = proc.stdout ? await new Response(proc.stdout).text() : "";
    await proc.exited;
    return text;
  } catch {
    return "";
  }
}
