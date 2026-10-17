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

export type LogExportFile = {
  write(events: readonly LogRecord[]): void;
  close(): void;
};

/** An export file that takes its records a page at a time: one JSON record per line. */
export function openLogExport(path: string): LogExportFile {
  ensureDir(dirname(path));
  const fd = openSync(path, "w", 0o600);
  let wrote = false;
  return {
    write(events) {
      let batch: string[] = [];
      let chars = 0;
      const flush = (): void => {
        if (batch.length > 0) {
          writeSync(fd, `${batch.join("\n")}\n`);
          wrote = true;
          batch = [];
          chars = 0;
        }
      };
      for (const ev of events) {
        const line = JSON.stringify(ev);
        batch.push(line);
        chars += line.length + 1;
        if (chars >= EXPORT_BATCH_CHARS) {
          flush();
        }
      }
      flush();
    },
    close() {
      try {
        if (!wrote) {
          // An empty export has always been a single newline.
          writeSync(fd, "\n");
        }
      } finally {
        closeSync(fd);
      }
    },
  };
}

export function writeLogExport(path: string, events: readonly LogRecord[]): void {
  const out = openLogExport(path);
  try {
    out.write(events);
  } finally {
    out.close();
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
