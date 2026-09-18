import { readdir, readFile, readlink } from "node:fs/promises";
import { isLoopbackPeer } from "../../domain/net/hosts.ts";
import { normalizeLlmCaller } from "../../domain/llm/caller.ts";
import { captureProcessOutput } from "./unix.ts";

const MAX_ANCESTOR_WALK = 8;

export type NamedPid = {
  readonly name: string;
  readonly pid: number;
};

export type TcpPeer = {
  readonly address: string;
  readonly port: number;
};

export type PeerCallerLookups = {
  readonly ownerPidForPort: (port: number) => Promise<number | undefined>;
  readonly ancestorPids: (pid: number) => Promise<number[]>;
  readonly processGroupId: (pid: number) => Promise<number | undefined>;
};

export async function callerServiceForPeer(
  peer: TcpPeer,
  services: () => readonly NamedPid[],
  lookups: PeerCallerLookups = defaultPeerCallerLookups(),
): Promise<string | undefined> {
  if (!isLoopbackPeer(peer.address) || !Number.isInteger(peer.port) || peer.port <= 0) {
    return undefined;
  }
  const ownerPid = await lookups.ownerPidForPort(peer.port);
  if (ownerPid === undefined) {
    return undefined;
  }
  const byPid = pidNameMap(services());
  const ancestors = await lookups.ancestorPids(ownerPid);
  for (const pid of ancestors) {
    const name = byPid.get(pid);
    if (name !== undefined) {
      return normalizeLlmCaller(name);
    }
  }
  const pgid = await lookups.processGroupId(ownerPid);
  if (pgid === undefined) {
    return undefined;
  }
  const grouped = byPid.get(pgid);
  return grouped === undefined ? undefined : normalizeLlmCaller(grouped);
}

function defaultPeerCallerLookups(): PeerCallerLookups {
  return {
    ownerPidForPort,
    ancestorPids,
    processGroupId,
  };
}

export function parseLsofLocalTcpOwner(text: string, port: number): number | undefined {
  const needle = `:${port}->`;
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("COMMAND") && line.includes(needle));
  for (const line of lines) {
    const pid = Number(line.trim().split(/\s+/)[1]);
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }
  return undefined;
}

export function parseNetstatLocalTcpOwner(text: string, port: number): number | undefined {
  const localSuffix = `:${port}`;
  const lines = text.split("\n").filter((line) => {
    if (!line.toUpperCase().includes("ESTABLISHED")) {
      return false;
    }
    const local = line.trim().split(/\s+/)[1] ?? "";
    return local.endsWith(localSuffix);
  });
  for (const line of lines) {
    const pid = Number(line.trim().split(/\s+/).at(-1));
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }
  return undefined;
}

export function parsePsPidColumn(text: string): number | undefined {
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  return pid;
}

function pidNameMap(services: readonly NamedPid[]): Map<number, string> {
  const byPid = new Map<number, string>();
  for (const svc of services) {
    if (svc.pid > 0 && !byPid.has(svc.pid)) {
      byPid.set(svc.pid, svc.name);
    }
  }
  return byPid;
}

// Parse /proc/net/tcp or /proc/net/tcp6 for the inode of the socket whose
// LOCAL port equals `port` — the inbound peer's ephemeral source port. Matching
// the local column and never the remote mirrors the lsof `:${port}->` needle:
// the proxy's own accept socket carries this port on its remote side and must
// not be picked. An ESTABLISHED row wins when several share the port, so a stale
// TIME_WAIT on a reused ephemeral port cannot mask the live connection (those
// carry inode 0 and are skipped anyway).
export function parseProcNetTcpInode(text: string, port: number): string | undefined {
  let fallback: string | undefined;
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const local = cols[1] ?? "";
    // Skip the header (`local_address`) and blank lines: a real row is `hex:hex`.
    if (!/^[0-9A-Fa-f]+:[0-9A-Fa-f]+$/.test(local)) {
      continue;
    }
    const localPort = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
    if (localPort !== port) {
      continue;
    }
    const inode = cols[9] ?? "";
    if (!/^[0-9]+$/.test(inode) || inode === "0") {
      continue;
    }
    if ((cols[3] ?? "").toUpperCase() === "01") {
      return inode;
    }
    fallback ??= inode;
  }
  return fallback;
}

// Parse a /proc/<pid>/stat line for its parent pid and process-group id. `comm`
// (field 2) is parenthesised and may itself contain spaces and parens (a
// process renamed e.g. "(uv run (py))"), so the fixed fields are read from
// AFTER the final ')': the kernel writes comm as the only parenthesised field,
// so the last ')' always closes it. What follows is `state ppid pgrp ...`.
export function parseProcPidStat(text: string): { ppid: number; pgid: number } | undefined {
  const close = text.lastIndexOf(")");
  if (close < 0) {
    return undefined;
  }
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const pgid = Number(rest[2]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) {
    return undefined;
  }
  return { ppid, pgid };
}

async function readProcText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

// Resolve the owning pid of a loopback peer's socket via /proc alone — no lsof,
// no ps. Always available in a Linux container; the shelled-out tools often are
// not (minimal python/uv images ship neither), which silently left caller
// empty. Reads both address families since a `localhost` client can land in
// tcp6 as an IPv4-mapped address that isLoopbackPeer still accepts.
async function ownerPidForPortProc(port: number): Promise<number | undefined> {
  const inodes = new Set<string>();
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const inode = parseProcNetTcpInode(await readProcText(path), port);
    if (inode !== undefined) {
      inodes.add(inode);
    }
  }
  if (inodes.size === 0) {
    return undefined;
  }
  return pidOwningSocketInode(inodes);
}

async function pidOwningSocketInode(inodes: ReadonlySet<string>): Promise<number | undefined> {
  const targets = new Set([...inodes].map((inode) => `socket:[${inode}]`));
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) {
      continue;
    }
    let fds: string[];
    try {
      fds = await readdir(`/proc/${name}/fd`);
    } catch {
      continue; // process exited, or its fds are not ours to read — skip
    }
    for (const fd of fds) {
      try {
        if (targets.has(await readlink(`/proc/${name}/fd/${fd}`))) {
          return Number(name);
        }
      } catch {
        // fd closed between readdir and readlink — skip
      }
    }
  }
  return undefined;
}

async function ownerPidForPort(port: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    return parseNetstatLocalTcpOwner(await captureProcessOutput(["netstat", "-ano"]), port);
  }
  if (process.platform === "linux") {
    const viaProc = await ownerPidForPortProc(port);
    if (viaProc !== undefined) {
      return viaProc;
    }
    // Fall through to lsof: /proc came up empty (hidepid, an unusual namespace),
    // but the binary may still be installed.
  }
  return parseLsofLocalTcpOwner(await captureProcessOutput(["lsof", "-nP", `-iTCP:${port}`]), port);
}

async function ancestorPids(pid: number): Promise<number[]> {
  const chain: number[] = [];
  let current: number | undefined = pid;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK && current !== undefined; depth += 1) {
    if (chain.includes(current)) {
      return chain;
    }
    chain.push(current);
    current = await parentPid(current);
    if (current === undefined || current <= 1) {
      return chain;
    }
  }
  return chain;
}

async function parentPid(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  if (process.platform === "linux") {
    const stat = parseProcPidStat(await readProcText(`/proc/${pid}/stat`));
    if (stat !== undefined) {
      return stat.ppid;
    }
  }
  return parsePsPidColumn(await captureProcessOutput(["ps", "-o", "ppid=", "-p", String(pid)]));
}

async function processGroupId(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  if (process.platform === "linux") {
    const stat = parseProcPidStat(await readProcText(`/proc/${pid}/stat`));
    if (stat !== undefined) {
      return stat.pgid;
    }
  }
  return parsePsPidColumn(await captureProcessOutput(["ps", "-o", "pgid=", "-p", String(pid)]));
}
