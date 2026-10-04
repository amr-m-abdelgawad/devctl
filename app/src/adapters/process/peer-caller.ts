import { readdir, readFile, readlink } from "node:fs/promises";
import { isLoopbackPeer } from "../../domain/net/hosts.ts";
import { normalizeLlmCaller } from "../../domain/llm/caller.ts";
import { captureProcessOutput } from "./unix.ts";

const MAX_ANCESTOR_WALK = 8;
// The managed-descendant index is rebuilt at most this often, sooner when a
// managed process starts or exits.
const INDEX_MAX_AGE_MS = 2_000;
// A socket no indexed process holds may belong to a child started since the
// last rebuild. A miss rebuilds the index, but not more often than this.
const INDEX_MISS_REFRESH_MS = 250;
const SOCKET_CACHE_MAX = 4_096;

export type NamedPid = {
  readonly name: string;
  readonly pid: number;
};

export type TcpPeer = {
  readonly address: string;
  readonly port: number;
  /** The proxy's own port on this connection: the remote column of the peer's socket row. */
  readonly proxyPort?: number;
};

/** Owner and ancestry lookups for hosts without /proc (lsof, netstat, ps). */
export type PeerCallerLookups = {
  readonly ownerPidForPort: (port: number) => Promise<number | undefined>;
  readonly ancestorPids: (pid: number) => Promise<number[]>;
  readonly processGroupId: (pid: number) => Promise<number | undefined>;
};

/** The parts of /proc the resolver reads, rooted at `root`. Unreadable paths come back undefined or empty. */
export type ProcFs = {
  readonly root: string;
  readonly readText: (path: string) => Promise<string | undefined>;
  readonly list: (path: string) => Promise<string[]>;
  readonly link: (path: string) => Promise<string | undefined>;
};

export function nodeProcFs(root = "/proc"): ProcFs {
  return {
    root,
    readText: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    list: async (path) => {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },
    link: async (path) => {
      try {
        return await readlink(path);
      } catch {
        return undefined;
      }
    },
  };
}

type ProcLink = { readonly ppid: number; readonly pgid: number };
type Owner = { readonly inode: string; readonly caller: string | undefined; readonly pid?: number; readonly fd?: string };
// A miss holds only while the index that produced it is current: the socket
// may belong to a child the next rebuild picks up.
type CachedSocket = Owner & { readonly generation: number };

/**
 * Names the managed service behind a loopback peer. On Linux it reads the
 * peer's socket inode from /proc/net/tcp and looks for it only among managed
 * processes and their descendants, from an index rebuilt every couple of
 * seconds or when a managed process starts or exits. It never scans every
 * process's fds: the daemon alone can hold thousands. A port's answer is kept
 * while the port still maps to the same socket, and concurrent lookups for a
 * port share one resolution. When the proxy's side of the connection is known,
 * that pair names one live socket, so a repeat lookup only checks that its
 * holder still has it open.
 */
export class PeerCallerResolver {
  private readonly now: () => number;
  private readonly sockets = new Map<string, CachedSocket>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private index = new Map<number, string>();
  private generation = 0;
  private indexAt = Number.NEGATIVE_INFINITY;
  private indexDirty = true;
  private rebuilding?: Promise<Map<number, string>>;

  constructor(private readonly opts: { readonly proc?: ProcFs; readonly lookups?: PeerCallerLookups; readonly now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  /** A managed process started or exited, so the index is stale. */
  markDirty(): void {
    this.indexDirty = true;
  }

  callerFor(peer: TcpPeer, services: () => readonly NamedPid[]): Promise<string | undefined> {
    const key = peer.proxyPort === undefined ? String(peer.port) : `${peer.port}>${peer.proxyPort}`;
    const running = this.inflight.get(key);
    if (running) {
      return running;
    }
    const lookup = this.resolve(peer, key, services).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, lookup);
    return lookup;
  }

  private async resolve(peer: TcpPeer, key: string, services: () => readonly NamedPid[]): Promise<string | undefined> {
    const proc = this.opts.proc;
    if (proc === undefined) {
      return this.resolveByLookups(peer.port, services);
    }
    const cached = this.sockets.get(key);
    if (peer.proxyPort !== undefined && cached?.caller !== undefined && (await stillHeld(proc, cached))) {
      return cached.caller;
    }
    const inodes = await socketInodes(proc, peer.port, peer.proxyPort);
    if (inodes === undefined) {
      // /proc/net/tcp is unreadable here, so ask lsof instead.
      return this.resolveByLookups(peer.port, services);
    }
    if (inodes.length === 0) {
      return undefined;
    }
    if (cached !== undefined && inodes.includes(cached.inode) && (cached.caller !== undefined || !this.missMayRebuild(cached))) {
      return cached.caller;
    }
    const scanned = new Set<number>();
    let found = await this.findOwner(proc, inodes, await this.managedIndex(services, false), scanned);
    if (found === undefined && this.now() - this.indexAt >= INDEX_MISS_REFRESH_MS) {
      found = await this.findOwner(proc, inodes, await this.managedIndex(services, true), scanned);
    }
    this.remember(key, { ...(found ?? { inode: inodes[0]!, caller: undefined }), generation: this.generation });
    return found?.caller;
  }

  // The lookup races the caller closing its socket, so it reads the cheapest
  // candidates first: each one's descriptors are listed up front (one readdir
  // each), and processes holding the fewest are read before one that holds
  // thousands. A caller usually holds a few dozen.
  private async findOwner(proc: ProcFs, inodes: readonly string[], index: ReadonlyMap<number, string>, scanned: Set<number>): Promise<Owner | undefined> {
    const targets = new Map(inodes.map((inode) => [`socket:[${inode}]`, inode]));
    const pending = [...index].filter(([pid]) => !scanned.has(pid));
    const candidates = await Promise.all(pending.map(async ([pid, name]) => ({ pid, name, fds: await proc.list(`${proc.root}/${pid}/fd`) })));
    candidates.sort((a, b) => a.fds.length - b.fds.length || a.pid - b.pid);
    for (const candidate of candidates) {
      scanned.add(candidate.pid);
      const held = await heldSocket(proc, candidate.pid, candidate.fds, targets);
      if (held !== undefined) {
        return { ...held, pid: candidate.pid, caller: normalizeLlmCaller(candidate.name) };
      }
    }
    return undefined;
  }

  private async managedIndex(services: () => readonly NamedPid[], force: boolean): Promise<ReadonlyMap<number, string>> {
    const proc = this.opts.proc;
    if (proc === undefined) {
      return this.index;
    }
    const stale = force || this.indexDirty || this.now() - this.indexAt >= INDEX_MAX_AGE_MS;
    if (!stale) {
      return this.index;
    }
    if (this.rebuilding === undefined) {
      this.indexDirty = false;
      this.rebuilding = readProcTable(proc)
        .then((table) => {
          this.index = managedCallers(table, services());
          this.generation += 1;
          this.indexAt = this.now();
          return this.index;
        })
        .finally(() => {
          this.rebuilding = undefined;
        });
    }
    return this.rebuilding;
  }

  // A cached miss is rechecked once the index it came from was rebuilt, or is
  // old enough that a miss would rebuild it.
  private missMayRebuild(cached: CachedSocket): boolean {
    return cached.generation !== this.generation || this.now() - this.indexAt >= INDEX_MISS_REFRESH_MS;
  }

  private remember(key: string, socket: CachedSocket): void {
    this.sockets.delete(key);
    this.sockets.set(key, socket);
    if (this.sockets.size > SOCKET_CACHE_MAX) {
      const oldest = this.sockets.keys().next().value;
      if (oldest !== undefined) {
        this.sockets.delete(oldest);
      }
    }
  }

  private async resolveByLookups(port: number, services: () => readonly NamedPid[]): Promise<string | undefined> {
    const lookups = this.opts.lookups;
    if (lookups === undefined) {
      return undefined;
    }
    const ownerPid = await lookups.ownerPidForPort(port);
    if (ownerPid === undefined) {
      return undefined;
    }
    const byPid = pidNameMap(services());
    for (const pid of await lookups.ancestorPids(ownerPid)) {
      const name = byPid.get(pid);
      if (name !== undefined) {
        return normalizeLlmCaller(name);
      }
    }
    const pgid = await lookups.processGroupId(ownerPid);
    const grouped = pgid === undefined ? undefined : byPid.get(pgid);
    return grouped === undefined ? undefined : normalizeLlmCaller(grouped);
  }
}

export async function callerServiceForPeer(
  peer: TcpPeer,
  services: () => readonly NamedPid[],
  resolver: PeerCallerResolver = defaultResolver,
): Promise<string | undefined> {
  if (!isLoopbackPeer(peer.address) || !Number.isInteger(peer.port) || peer.port <= 0) {
    return undefined;
  }
  return resolver.callerFor(peer, services);
}

/**
 * pid → service name for every managed process, every descendant within the
 * ancestor walk, and every member of a managed process group: the same
 * matches the per-owner walk made, computed once for the whole table.
 */
export function managedCallers(table: ReadonlyMap<number, ProcLink>, services: readonly NamedPid[]): Map<number, string> {
  const byPid = pidNameMap(services);
  const out = new Map<number, string>();
  for (const [pid, name] of byPid) {
    out.set(pid, name);
  }
  for (const [pid, link] of table) {
    if (out.has(pid)) {
      continue;
    }
    const name = nearestManaged(pid, table, byPid) ?? byPid.get(link.pgid);
    if (name !== undefined) {
      out.set(pid, name);
    }
  }
  return out;
}

function nearestManaged(pid: number, table: ReadonlyMap<number, ProcLink>, byPid: ReadonlyMap<number, string>): string | undefined {
  const chain: number[] = [];
  let current: number | undefined = pid;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK && current !== undefined; depth += 1) {
    if (chain.includes(current)) {
      return undefined;
    }
    chain.push(current);
    const name = byPid.get(current);
    if (name !== undefined) {
      return name;
    }
    current = table.get(current)?.ppid;
    if (current === undefined || current <= 1) {
      return undefined;
    }
  }
  return undefined;
}

async function readProcTable(proc: ProcFs): Promise<Map<number, ProcLink>> {
  const pids = (await proc.list(proc.root)).filter((name) => /^[0-9]+$/.test(name));
  const rows = await Promise.all(pids.map(async (name) => {
    const stat = parseProcPidStat((await proc.readText(`${proc.root}/${name}/stat`)) ?? "");
    return stat === undefined ? undefined : ([Number(name), stat] as const);
  }));
  const table = new Map<number, ProcLink>();
  for (const row of rows) {
    if (row !== undefined) {
      table.set(row[0], row[1]);
    }
  }
  return table;
}

/** Socket inodes whose local port is `port`, or undefined when /proc/net/tcp cannot be read. */
async function socketInodes(proc: ProcFs, port: number, remotePort: number | undefined): Promise<string[] | undefined> {
  const tcp = await proc.readText(`${proc.root}/net/tcp`);
  const v4 = tcp === undefined ? undefined : parseProcNetTcpInode(tcp, port, remotePort);
  if (v4 !== undefined) {
    return [v4];
  }
  // A `localhost` client can land in tcp6 as an IPv4-mapped address.
  const tcp6 = await proc.readText(`${proc.root}/net/tcp6`);
  const v6 = tcp6 === undefined ? undefined : parseProcNetTcpInode(tcp6, port, remotePort);
  if (v6 !== undefined) {
    return [v6];
  }
  return tcp === undefined && tcp6 === undefined ? undefined : [];
}

const LINK_BATCH = 64;

// Reads a process's descriptors from the highest number down, a batch at a
// time. A process that holds many long-lived descriptors gets its newest
// socket above them, so the one just connected is in the first batch.
async function heldSocket(proc: ProcFs, pid: number, fds: readonly string[], targets: ReadonlyMap<string, string>): Promise<{ inode: string; fd: string } | undefined> {
  const dir = `${proc.root}/${pid}/fd`;
  const newestFirst = [...fds].sort((a, b) => Number(b) - Number(a));
  for (let start = 0; start < newestFirst.length; start += LINK_BATCH) {
    const batch = newestFirst.slice(start, start + LINK_BATCH);
    const links = await Promise.all(batch.map((fd) => proc.link(`${dir}/${fd}`)));
    for (let index = 0; index < batch.length; index += 1) {
      const link = links[index];
      const inode = link === undefined ? undefined : targets.get(link);
      if (inode !== undefined) {
        return { inode, fd: batch[index]! };
      }
    }
  }
  return undefined;
}

// While its holder keeps the socket open, no other connection can have the
// same client and proxy ports, so the earlier answer still stands.
async function stillHeld(proc: ProcFs, socket: CachedSocket): Promise<boolean> {
  if (socket.pid === undefined || socket.fd === undefined) {
    return false;
  }
  return (await proc.link(`${proc.root}/${socket.pid}/fd/${socket.fd}`)) === `socket:[${socket.inode}]`;
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
// carry inode 0 and are skipped anyway). Only rows that mention the port are
// split, so a table of thousands of sockets costs one substring search. With
// `remotePort` (the proxy's side), a socket the client holds to some other
// destination on the same local port cannot be picked.
export function parseProcNetTcpInode(text: string, port: number, remotePort?: number): string | undefined {
  const needle = `:${port.toString(16).toUpperCase().padStart(4, "0")} `;
  let fallback: string | undefined;
  for (let at = text.indexOf(needle); at >= 0; ) {
    const start = text.lastIndexOf("\n", at) + 1;
    const newline = text.indexOf("\n", at);
    const end = newline < 0 ? text.length : newline;
    const row = parseTcpRow(text.slice(start, end), port, remotePort);
    if (row?.established) {
      return row.inode;
    }
    fallback ??= row?.inode;
    at = newline < 0 ? -1 : text.indexOf(needle, newline);
  }
  return fallback;
}

function parseTcpRow(line: string, port: number, remotePort: number | undefined): { inode: string; established: boolean } | undefined {
  const cols = line.trim().split(/\s+/);
  const local = cols[1] ?? "";
  // Skip the header (`local_address`) and blank lines: a real row is `hex:hex`.
  if (!/^[0-9A-Fa-f]+:[0-9A-Fa-f]+$/.test(local) || addressPort(local) !== port) {
    return undefined;
  }
  if (remotePort !== undefined && addressPort(cols[2] ?? "") !== remotePort) {
    return undefined;
  }
  const inode = cols[9] ?? "";
  if (!/^[0-9]+$/.test(inode) || inode === "0") {
    return undefined;
  }
  return { inode, established: (cols[3] ?? "").toUpperCase() === "01" };
}

function addressPort(address: string): number {
  return Number.parseInt(address.slice(address.lastIndexOf(":") + 1), 16);
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

const shellLookups: PeerCallerLookups = { ownerPidForPort, ancestorPids, processGroupId };

const defaultResolver = new PeerCallerResolver(
  process.platform === "linux" ? { proc: nodeProcFs(), lookups: shellLookups } : { lookups: shellLookups },
);

/** ProcessManager reports each managed start and exit, so the index rebuilds on the next lookup. */
export function rememberManagedPid(pid: number): void {
  if (pid > 0) {
    defaultResolver.markDirty();
  }
}

export function forgetManagedPid(pid: number): void {
  if (pid > 0) {
    defaultResolver.markDirty();
  }
}
