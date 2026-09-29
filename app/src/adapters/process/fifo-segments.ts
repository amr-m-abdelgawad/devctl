import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const FIFO_SEGMENT_BYTES = 256 * 1024;

export function serviceStdioDir(root: string, service: string): string {
  return join(root, safeStdioName(service));
}

function safeStdioName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned === "" ? "service" : cleaned;
}

export function segmentPath(dir: string, seq: number): string {
  return join(dir, `seg-${padSeq(seq)}`);
}

export function readyPath(dir: string, seq: number): string {
  return join(dir, `ready-${padSeq(seq)}`);
}

export function ensureStdioDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function directoryBytes(dir: string): number {
  let total = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      total += st.isDirectory() ? directoryBytes(join(dir, name)) : st.size;
    } catch {
      // a segment was consumed between readdir and stat
    }
  }
  return total;
}

export function readySequences(dir: string): number[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const seqs: number[] = [];
  for (const name of names) {
    if (name.startsWith("ready-")) {
      const seq = Number(name.slice("ready-".length));
      if (Number.isInteger(seq)) {
        seqs.push(seq);
      }
    }
  }
  seqs.sort((a, b) => a - b);
  return seqs;
}

function padSeq(seq: number): string {
  return String(seq).padStart(8, "0");
}
