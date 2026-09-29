import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LogRecord } from "../../domain/logs/logs.ts";
import { ensureDir, exportsDir, resolveUserPath } from "./storage.ts";

export function defaultExportPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(exportsDir(), `devctl-logs-${stamp}.jsonl`);
}

export function resolveExportPath(input = ""): string {
  if (input === "") {
    return defaultExportPath();
  }
  return resolveUserPath(input, process.cwd());
}

export function writeLogExport(path: string, events: LogRecord[]): void {
  ensureDir(dirname(path));
  const lines = events.map((ev) => JSON.stringify(ev));
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

export function openInFileManager(target: string): void {
  const folder = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
  ensureDir(folder);
  if (process.platform === "darwin") {
    const args = existsSync(target) && statSync(target).isFile() ? ["-R", target] : [folder];
    spawn("open", args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("explorer", [folder], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [folder], { detached: true, stdio: "ignore" }).unref();
}
