import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync, writeSync } from "node:fs";
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

// Written in batches of about this size, so a large window is never one string.
const EXPORT_BATCH_CHARS = 1024 * 1024;

export function writeLogExport(path: string, events: readonly LogRecord[]): void {
  ensureDir(dirname(path));
  const fd = openSync(path, "w", 0o600);
  try {
    let batch: string[] = [];
    let chars = 0;
    for (const ev of events) {
      const line = JSON.stringify(ev);
      batch.push(line);
      chars += line.length + 1;
      if (chars >= EXPORT_BATCH_CHARS) {
        writeSync(fd, `${batch.join("\n")}\n`);
        batch = [];
        chars = 0;
      }
    }
    if (batch.length > 0 || events.length === 0) {
      writeSync(fd, `${batch.join("\n")}\n`);
    }
  } finally {
    closeSync(fd);
  }
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
