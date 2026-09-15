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

async function ownerPidForPort(port: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    return parseNetstatLocalTcpOwner(await captureProcessOutput(["netstat", "-ano"]), port);
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
  return parsePsPidColumn(await captureProcessOutput(["ps", "-o", "ppid=", "-p", String(pid)]));
}

async function processGroupId(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  return parsePsPidColumn(await captureProcessOutput(["ps", "-o", "pgid=", "-p", String(pid)]));
}
