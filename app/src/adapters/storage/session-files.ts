import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_SCAN_BYTES } from "../../domain/logs/budgets.ts";
import { buildLogRecord, isPlainObject, parseJSONLogLine, type LogRecord } from "../../domain/logs/logs.ts";
import { logsDir } from "./storage.ts";

export const SESSION_PREFIX = "session-";
export const SESSION_FORMAT_FILE = "FORMAT";
export const SESSION_FORMAT_JSONL = "jsonl";

export function listSessions(root = logsDir()): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((name) => name.startsWith(SESSION_PREFIX))
    .sort()
    .reverse();
}

/** A session directory name as `listSessions` gives it, safe to join under the logs root. */
export function isSessionName(name: string): boolean {
  return name.length > SESSION_PREFIX.length && name.startsWith(SESSION_PREFIX) && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

export function isJsonlSessionDir(dir: string): boolean {
  const marker = join(dir, SESSION_FORMAT_FILE);
  if (existsSync(marker)) {
    return readFileSync(marker, "utf8").trim() === SESSION_FORMAT_JSONL;
  }
  if (!existsSync(dir)) {
    return false;
  }
  return readdirSync(dir).some((name) => name.endsWith(".jsonl"));
}

export function loadSessionEvents(sessionName: string, root = logsDir()): LogRecord[] {
  const dir = join(root, sessionName);
  if (!existsSync(dir)) {
    return [];
  }
  if (isJsonlSessionDir(dir)) {
    return loadJsonlSession(dir);
  }
  return loadLegacySession(dir);
}

/** Reads at most `maxBytes` from the end of each session file, then keeps the newest `maxRecords`. */
export function loadSessionTail(sessionName: string, root = logsDir(), maxRecords = 50_000, maxBytes = HISTORY_SCAN_BYTES): LogRecord[] {
  const dir = join(root, sessionName);
  if (!existsSync(dir)) {
    return [];
  }
  if (!isJsonlSessionDir(dir)) {
    return loadSessionEvents(sessionName, root).slice(-maxRecords);
  }
  const records: LogRecord[] = [];
  let read = 0;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".jsonl") && read < maxBytes) {
      const tail = readTail(join(dir, name), maxBytes - read);
      read += Buffer.byteLength(tail);
      for (const line of tail.split("\n")) {
        const record = line.trim() === "" ? undefined : parseStoredLogRecord(line);
        if (record) {
          records.push(record);
        }
      }
    }
  }
  records.sort((a, b) => a.seq - b.seq || a.timestamp.localeCompare(b.timestamp));
  return records.slice(-maxRecords);
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    const newline = start === 0 ? -1 : text.indexOf("\n");
    return newline < 0 ? text : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}

function loadJsonlSession(dir: string): LogRecord[] {
  const bySeq = new Map<number, LogRecord>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const text = readFileSync(join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const record = parseStoredLogRecord(line);
      if (record) {
        bySeq.set(record.seq, record);
      }
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq || a.timestamp.localeCompare(b.timestamp));
}

function loadLegacySession(dir: string): LogRecord[] {
  const events: LogRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".log")) {
      continue;
    }
    const text = readFileSync(join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const parts = line.split(" ");
      const rawMessage = parts.slice(3).join(" ");
      const structured = parseJSONLogLine(rawMessage);
      events.push(buildLogRecord(
        {
          timestamp: parts[0] ?? "",
          service: parts[1] ?? name.replace(/\.log$/, ""),
          source: "history",
          pid: 0,
          level: parts[2] ?? "INFO",
          message: rawMessage,
        },
        structured ?? { body: rawMessage, raw: rawMessage },
        0,
      ));
    }
  }
  const sorted = events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  sorted.forEach((ev, i) => {
    ev.seq = i + 1;
  });
  return sorted;
}

export function parseStoredLogRecord(line: string): LogRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!isPlainObject(value) || typeof value.service !== "string" || typeof value.seq !== "number") {
      return undefined;
    }
    return value as LogRecord;
  } catch {
    return undefined;
  }
}

export function safeServiceFile(service: string): string {
  const cleaned = service.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned === "" ? "service" : cleaned;
}
