import { readdir, readFile, readlink } from "node:fs/promises";
import { isLoopbackPeer } from "../../domain/net/hosts.ts";
import { normalizeLlmCaller } from "../../domain/llm/caller.ts";
import { parseProcStartTicks } from "./liveness.ts";
import { openSocketDiag, type SocketDiag } from "./sock-diag.ts";
import { captureProcessOutput } from "./unix.ts";

const MAX_ANCESTOR_WALK = 8;
// The managed-descendant index is rebuilt at most this often, sooner when a
// managed process starts or exits.
const INDEX_MAX_AGE_MS = 2_000;
// A socket no indexed process holds may belong to a child started since the
// last rebuild. A miss rebuilds the index, but not more often than this.
const INDEX_MISS_REFRESH_MS = 250;
const SOCKET_CACHE_MAX = 4_096;
// Answers from the kernel's socket lookup that prove nothing before it is
// given up on for the life of the process. A kernel that has the lookup
// proves it on the first connection.
const KERNEL_DOUBTS_MAX = 3;
// Lookups that share one read of a socket table each search it for their row
// until this many have; the rest are answered from one index of the table.
// Indexing a table costs about two searches of it.
const SEARCHES_BEFORE_INDEX = 2;
// Processes devctl does not run that held recently looked-up sockets. Each
// one's last descriptor is read before anything else, and each is read
// before any managed process larger than it: otherwise every new connection
// from such a client costs a read of every managed process's descriptors.
const HOT_OWNERS_MAX = 4;
// A hot owner that has held none of the looked-up sockets for this long is dropped.
const HOT_IDLE_MS = 10_000;
// A scan lists, all at once before it reads anything, every candidate last
// seen with at most this many descriptors, and every one not seen before.
// Larger ones are listed only when their turn comes. Hot owners are read
// after every managed process this small.
const LIST_AHEAD_MAX = 256;
// The search for a hot owner runs only while lookups have recently found no managed owner.
const MISS_RECENT_MS = 5_000;
// Descriptors one search for a hot owner reads at most.
const OWNER_SEARCH_LINKS_MAX = 1_024;
// After a search that found no owner the next waits this long, doubled after each such search.
const OWNER_SEARCH_BACKOFF_MIN_MS = 100;
const OWNER_SEARCH_BACKOFF_MAX_MS = 6_400;

export type NamedPid = {
  readonly name: string;
  readonly pid: number;
};

export type TcpPeer = {
  readonly address: string;
  readonly port: number;
  /** The proxy's own port on this connection: the remote column of the peer's socket row. */
  readonly proxyPort?: number;
  /** The proxy's own address on this connection. With `proxyPort`, the kernel can be asked for the one socket. */
  readonly proxyAddress?: string;
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
// Where a hot owner held the last socket it was found with.
type HotOwner = { readonly pid: number; readonly fd: string; readonly hitAt: number };
// A miss holds only while the index that produced it is current: the socket
// may belong to a child the next rebuild picks up.
type CachedSocket = Owner & { readonly generation: number };

/**
 * Names the managed service behind a loopback peer. On Linux it asks the
 * kernel for the inode of the peer's one socket (netlink sock_diag), which
 * costs the same however many sockets the host has. Where the kernel cannot
 * be asked it reads the inode from /proc/net/tcp, one read at a time shared by
 * the lookups waiting for it. It looks for that inode only among managed
 * processes and their descendants, from an index rebuilt every couple of
 * seconds or when a managed process starts or exits. It never scans every
 * process's fds: the daemon alone can hold thousands. A port's answer is kept
 * while the port still maps to the same socket, and concurrent lookups for a
 * port share one resolution. When the proxy's side of the connection is known,
 * that pair names one live socket, so a repeat lookup only checks that its
 * holder still has it open.
 *
 * A socket no managed process holds can only be ruled out by reading all of
 * their descriptors. So once lookups miss, the processes devctl does not run
 * are searched, newest first, for the holder of a socket still being looked
 * up. From then on that holder's last descriptor is read first, and the
 * holder joins the scan in size order. A socket found in it is judged by the
 * rule the index uses, read fresh from /proc; one it holds unmanaged gets no
 * caller without the larger managed processes being read, even if one of
 * them holds the same socket too (one passed it to the other).
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
  private readonly tables?: { readonly v4: SharedTableRead; readonly v6: SharedTableRead };
  private kernel?: SocketDiag;
  private kernelOpened = false;
  private kernelOpening?: Promise<void>;
  private kernelTrusted = false;
  private kernelDoubts = 0;
  private hot: HotOwner[] = [];
  // Descriptors each candidate held when last listed: the order of the next scan.
  private readonly fdCounts = new Map<number, number>();
  // Service (or none) per process, keyed by pid and start time; dropped when the index changes.
  private readonly verdicts = new Map<string, string | undefined>();
  private verdictsGeneration = 0;
  // The sockets of lookups now reading the managed processes, by fd link: what an owner search looks for.
  private readonly wanted = new Map<string, string>();
  private missedAt = Number.NEGATIVE_INFINITY;
  private searching = false;
  private searchNotBefore = Number.NEGATIVE_INFINITY;
  private searchBackoff = OWNER_SEARCH_BACKOFF_MIN_MS;

  constructor(
    private readonly opts: {
      readonly proc?: ProcFs;
      readonly lookups?: PeerCallerLookups;
      readonly now?: () => number;
      /** Opens the kernel's socket lookup, once, on the first lookup that reads /proc. */
      readonly openKernel?: () => Promise<SocketDiag | undefined>;
      /** This process, which holds the proxy's side of every connection and is never a caller. */
      readonly self?: number;
    },
  ) {
    this.now = opts.now ?? Date.now;
    const proc = opts.proc;
    if (proc !== undefined) {
      this.tables = { v4: new SharedTableRead(proc, `${proc.root}/net/tcp`), v6: new SharedTableRead(proc, `${proc.root}/net/tcp6`) };
    }
  }

  /** A managed process started, exited or was adopted, so the index and every verdict are stale. */
  markDirty(): void {
    this.indexDirty = true;
    this.verdicts.clear();
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
    const inodes = await this.socketInodes(peer);
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
    const found = await this.ownerOf(proc, inodes, services, this.stillOpen(peer, inodes));
    this.remember(key, { ...(found ?? { inode: inodes[0]!, caller: undefined }), generation: this.generation });
    return found?.caller;
  }

  // Whether the peer's socket is still open, from the kernel. Once it has
  // closed no process holds it, so a scan still under way can stop: under
  // load a lookup can start its scan after a short connection has already
  // ended, and reading every descriptor for it would only add to the load.
  // Undefined where the kernel cannot be asked about this connection.
  private stillOpen(peer: TcpPeer, inodes: readonly string[]): (() => boolean) | undefined {
    const kernel = this.kernel;
    const inode = inodes[0];
    if (kernel === undefined || !this.kernelTrusted || inodes.length !== 1 || inode === undefined || peer.proxyPort === undefined || peer.proxyAddress === undefined) {
      return undefined;
    }
    const client = { address: peer.address, port: peer.port };
    const proxy = { address: peer.proxyAddress, port: peer.proxyPort };
    return () => {
      const answer = kernel.socket(client, proxy);
      if (typeof answer === "object") {
        return answer.inode === inode;
      }
      return answer === "unknown" || answer === "unasked";
    };
  }

  private async ownerOf(proc: ProcFs, inodes: readonly string[], services: () => readonly NamedPid[], open?: () => boolean): Promise<Owner | undefined> {
    const targets = new Map(inodes.map((inode) => [`socket:[${inode}]`, inode]));
    const now = this.now();
    this.hot = this.hot.filter((owner) => now - owner.hitAt < HOT_IDLE_MS);
    const candidates = this.withHotOwners(await this.managedIndex(services, false));
    const scanned = new Set<number>();
    // The hot owners' last descriptors are read while the small candidates
    // are listed, so a managed caller waits no longer than before for its own
    // process to be read.
    const [last, listed] = await Promise.all([this.hotLastDescriptor(proc, targets), this.listAhead(proc, candidates, scanned)]);
    if (last !== undefined) {
      return { ...last, caller: await this.verdict(proc, last.pid, services) };
    }
    if (open?.() === false) {
      this.missedAt = this.now();
      return undefined;
    }
    for (const [link, inode] of targets) {
      this.wanted.set(link, inode);
    }
    try {
      // Searched for now, while this socket is open: a client's connection
      // can close long before a scan past a process holding thousands of
      // descriptors would end.
      this.searchForOwner(proc, services);
      let found = await this.findOwner(proc, targets, candidates, scanned, listed, open);
      if (found === undefined && open?.() !== false && this.now() - this.indexAt >= INDEX_MISS_REFRESH_MS) {
        const rebuilt = this.withHotOwners(await this.managedIndex(services, true));
        found = await this.findOwner(proc, targets, rebuilt, scanned, await this.listAhead(proc, rebuilt, scanned), open);
      }
      if (found === undefined) {
        this.missedAt = this.now();
        return undefined;
      }
      if (found.name !== undefined) {
        return { inode: found.inode, fd: found.fd, pid: found.pid, caller: normalizeLlmCaller(found.name) };
      }
      this.hotHit(found.pid, found.inode, found.fd);
      return { inode: found.inode, fd: found.fd, pid: found.pid, caller: await this.verdict(proc, found.pid, services) };
    } finally {
      for (const link of targets.keys()) {
        this.wanted.delete(link);
      }
    }
  }

  // A client making one connection after another reuses its lowest free
  // descriptor, so each hot owner's last one is read before any scan.
  private async hotLastDescriptor(proc: ProcFs, targets: ReadonlyMap<string, string>): Promise<{ pid: number; inode: string; fd: string } | undefined> {
    const links = await Promise.all(this.hot.map((owner) => proc.link(`${proc.root}/${owner.pid}/fd/${owner.fd}`)));
    for (let index = 0; index < this.hot.length; index += 1) {
      const link = links[index];
      const inode = link === undefined ? undefined : targets.get(link);
      if (inode !== undefined) {
        const owner = this.hot[index]!;
        return this.hotHit(owner.pid, inode, owner.fd);
      }
    }
    return undefined;
  }

  // The hot owners join the scan as candidates with no service name. They are
  // read after every small managed process and before any larger one, so a
  // client holding many connections at once is found before a service
  // holding thousands, and a managed caller in a small service before it.
  private withHotOwners(index: ReadonlyMap<number, string>): ReadonlyMap<number, string | undefined> {
    const hot = this.hot.filter((owner) => !index.has(owner.pid));
    if (hot.length === 0) {
      return index;
    }
    const candidates = new Map<number, string | undefined>(index);
    for (const owner of hot) {
      candidates.set(owner.pid, undefined);
    }
    return candidates;
  }

  private hotHit(pid: number, inode: string, fd: string): { pid: number; inode: string; fd: string } {
    this.hot = [{ pid, fd, hitAt: this.now() }, ...this.hot.filter((owner) => owner.pid !== pid)].slice(0, HOT_OWNERS_MAX);
    return { pid, inode, fd };
  }

  // The service a process belongs to by the index's rule (itself, an ancestor
  // within the walk, or its process group), read fresh: a hot owner may have
  // been adopted as a service since it was found, and a service's
  // just-started child is not in the index yet.
  private async verdict(proc: ProcFs, pid: number, services: () => readonly NamedPid[]): Promise<string | undefined> {
    if (this.verdictsGeneration !== this.generation) {
      this.verdicts.clear();
      this.verdictsGeneration = this.generation;
    }
    const stat = (await proc.readText(`${proc.root}/${pid}/stat`)) ?? "";
    const key = `${pid}:${parseProcStartTicks(stat) ?? ""}`;
    if (this.verdicts.has(key)) {
      return this.verdicts.get(key);
    }
    const byPid = pidNameMap(services());
    const chain = new Map<number, ProcLink>();
    let current = pid;
    let link = parseProcPidStat(stat);
    for (let depth = 0; link !== undefined && depth < MAX_ANCESTOR_WALK; depth += 1) {
      chain.set(current, link);
      if (byPid.has(current) || link.ppid <= 1 || chain.has(link.ppid)) {
        break;
      }
      current = link.ppid;
      link = parseProcPidStat((await proc.readText(`${proc.root}/${current}/stat`)) ?? "");
    }
    const pgid = chain.get(pid)?.pgid;
    const name = nearestManaged(pid, chain, byPid) ?? (pgid === undefined ? undefined : byPid.get(pgid));
    const caller = name === undefined ? undefined : normalizeLlmCaller(name);
    this.verdicts.set(key, caller);
    return caller;
  }

  // Starts a search among the processes devctl does not run for one holding a
  // socket still being looked up, when lookups have found no managed owner of
  // late. One runs at a time; after one that finds nobody, the next waits.
  private searchForOwner(proc: ProcFs, services: () => readonly NamedPid[]): void {
    const now = this.now();
    if (this.searching || now - this.missedAt >= MISS_RECENT_MS || now < this.searchNotBefore) {
      return;
    }
    this.searching = true;
    void this.findUnmanagedOwner(proc, services)
      .catch(() => false)
      .then((found) => {
        // Even one that found its owner waits the least: the lookups right
        // after it read that owner anyway.
        if (found) {
          this.searchBackoff = OWNER_SEARCH_BACKOFF_MIN_MS;
          this.searchNotBefore = this.now() + OWNER_SEARCH_BACKOFF_MIN_MS;
        } else {
          this.searchNotBefore = this.now() + this.searchBackoff;
          this.searchBackoff = Math.min(this.searchBackoff * 2, OWNER_SEARCH_BACKOFF_MAX_MS);
        }
        this.searching = false;
      });
  }

  // Newest processes first: a client usually started after the services it
  // calls. Each one's descriptors are matched against the sockets of every
  // lookup under way, which come and go while the search runs.
  private async findUnmanagedOwner(proc: ProcFs, services: () => readonly NamedPid[]): Promise<boolean> {
    const self = this.opts.self ?? process.pid;
    const pids = (await proc.list(proc.root))
      .filter((name) => /^[0-9]+$/.test(name))
      .map(Number)
      .filter((pid) => pid !== self && !this.index.has(pid))
      .sort((a, b) => b - a);
    let budget = OWNER_SEARCH_LINKS_MAX;
    for (const pid of pids) {
      if (this.wanted.size === 0 || budget <= 0) {
        return false;
      }
      const fds = await proc.list(`${proc.root}/${pid}/fd`);
      if (fds.length === 0 || fds.length > budget) {
        continue;
      }
      budget -= fds.length;
      const held = await heldSocket(proc, pid, fds, this.wanted);
      if (held !== undefined) {
        // A managed process not in the index yet is the managed scan's to find.
        if ((await this.verdict(proc, pid, services)) !== undefined) {
          return false;
        }
        this.hotHit(pid, held.inode, held.fd);
        return true;
      }
    }
    return false;
  }

  /** Inodes of the peer's socket (none when it has closed), or undefined when neither the kernel nor /proc/net/tcp can say. */
  private async socketInodes(peer: TcpPeer): Promise<string[] | undefined> {
    const kernel = this.kernelOpened ? this.kernel : await this.openedKernel();
    const asked = kernel === undefined ? undefined : this.askKernel(kernel, peer);
    if (asked !== undefined) {
      return asked;
    }
    const tables = this.tables;
    if (tables === undefined) {
      return undefined;
    }
    const v4 = await tables.v4.fresh();
    const found = v4?.inode(peer.port, peer.proxyPort);
    if (found !== undefined) {
      return [found];
    }
    // A `localhost` client can land in tcp6 as an IPv4-mapped address.
    const v6 = await tables.v6.fresh();
    const found6 = v6?.inode(peer.port, peer.proxyPort);
    if (found6 !== undefined) {
      return [found6];
    }
    return v4 === undefined && v6 === undefined ? undefined : [];
  }

  private openedKernel(): Promise<SocketDiag | undefined> {
    const open = this.opts.openKernel;
    if (open === undefined) {
      this.kernelOpened = true;
      return Promise.resolve(undefined);
    }
    this.kernelOpening ??= open().then(
      (kernel) => {
        this.kernel = kernel;
        this.kernelOpened = true;
      },
      () => {
        this.kernelOpened = true;
      },
    );
    return this.kernelOpening.then(() => this.kernel);
  }

  // The kernel's answer for the client's end of this connection, or undefined
  // when the socket table has to give it instead.
  private askKernel(kernel: SocketDiag, peer: TcpPeer): string[] | undefined {
    if (peer.proxyPort === undefined || peer.proxyAddress === undefined) {
      return undefined;
    }
    const client = { address: peer.address, port: peer.port };
    const proxy = { address: peer.proxyAddress, port: peer.proxyPort };
    const answer = kernel.socket(client, proxy);
    if (answer === "unasked") {
      return undefined;
    }
    if (typeof answer === "object") {
      this.kernelTrusted = true;
      return [answer.inode];
    }
    if (answer === "closed" || (answer === "missing" && this.kernelTrusted)) {
      this.kernelTrusted = true;
      return [];
    }
    if (answer === "missing") {
      // A kernel built without the lookup says "missing" too. The proxy's own
      // end of this connection, or failing that its listening socket, is open
      // while the request is handled, so a kernel that answers for it can be
      // believed about the client's.
      const own = kernel.socket(proxy, client);
      if (typeof own === "object" || own === "closed") {
        this.kernelTrusted = true;
        return [];
      }
    }
    this.kernelDoubts += 1;
    if (!this.kernelTrusted && this.kernelDoubts >= KERNEL_DOUBTS_MAX) {
      this.kernel = undefined;
    }
    return undefined;
  }

  // Lists at once (one readdir each) the candidates that are small or not
  // seen before. A larger one waits for its turn in findOwner.
  private async listAhead(proc: ProcFs, candidates: ReadonlyMap<number, string | undefined>, scanned: ReadonlySet<number>): Promise<Map<number, string[]>> {
    const ahead = [...candidates.keys()].filter((pid) => !scanned.has(pid) && (this.fdCounts.get(pid) ?? 0) <= LIST_AHEAD_MAX);
    const rows = await Promise.all(ahead.map(async (pid) => [pid, await proc.list(`${proc.root}/${pid}/fd`)] as const));
    const listed = new Map<number, string[]>();
    for (const [pid, fds] of rows) {
      listed.set(pid, fds);
      this.fdCounts.set(pid, fds.length);
    }
    return listed;
  }

  // The lookup races the caller closing its socket, so it reads the cheapest
  // candidates first: processes holding the fewest descriptors are read
  // before one that holds thousands. A caller usually holds a few dozen. A
  // large process is listed only when its turn comes, in the order of the
  // counts last seen, so one holding thousands is not even listed when the
  // socket turns up before it; one that has grown past the next goes back in
  // line.
  private async findOwner(
    proc: ProcFs,
    targets: ReadonlyMap<string, string>,
    candidates: ReadonlyMap<number, string | undefined>,
    scanned: Set<number>,
    listed: Map<number, string[]>,
    open?: () => boolean,
  ): Promise<{ inode: string; fd: string; pid: number; name: string | undefined } | undefined> {
    const rank = (pid: number, name: string | undefined): number => {
      const count = this.fdCounts.get(pid) ?? 0;
      return name === undefined ? Math.max(count, LIST_AHEAD_MAX) : count;
    };
    const queue = [...candidates].filter(([pid]) => !scanned.has(pid)).map(([pid, name]) => ({ pid, name, rank: rank(pid, name) }));
    queue.sort(byRank);
    while (queue.length > 0) {
      if (open?.() === false) {
        return undefined;
      }
      const next = queue[0]!;
      let fds = listed.get(next.pid);
      if (fds === undefined) {
        fds = await proc.list(`${proc.root}/${next.pid}/fd`);
        listed.set(next.pid, fds);
        this.fdCounts.set(next.pid, fds.length);
        next.rank = rank(next.pid, next.name);
        const after = queue[1];
        if (after !== undefined && byRank(next, after) > 0) {
          queue.shift();
          const at = queue.findIndex((other) => byRank(next, other) < 0);
          queue.splice(at < 0 ? queue.length : at, 0, next);
          continue;
        }
      }
      queue.shift();
      scanned.add(next.pid);
      const held = await heldSocket(proc, next.pid, fds, targets, open);
      if (held !== undefined) {
        return { ...held, pid: next.pid, name: next.name };
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
          for (const pid of this.fdCounts.keys()) {
            if (!this.index.has(pid) && !this.hot.some((owner) => owner.pid === pid)) {
              this.fdCounts.delete(pid);
            }
          }
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

/**
 * Reads of one socket table (/proc/net/tcp or tcp6), one at a time. A lookup
 * that asks while a read is under way shares the read after it, because the
 * one under way may have begun before the lookup's socket was opened. A burst
 * of new connections then costs one read each time the last one ends, not one
 * read each.
 */
class SharedTableRead {
  private current?: Promise<TcpTable | undefined>;
  private next?: Promise<TcpTable | undefined>;

  constructor(
    private readonly proc: ProcFs,
    private readonly path: string,
  ) {}

  /** A read that begins no earlier than this call; undefined when the table cannot be read. */
  fresh(): Promise<TcpTable | undefined> {
    if (this.current === undefined) {
      return this.begin();
    }
    this.next ??= this.current.then(
      () => this.begin(),
      () => this.begin(),
    );
    return this.next;
  }

  private begin(): Promise<TcpTable | undefined> {
    this.next = undefined;
    const read: Promise<TcpTable | undefined> = this.proc
      .readText(this.path)
      .then((text) => (text === undefined ? undefined : new TcpTable(text)))
      .finally(() => {
        if (this.current === read && this.next === undefined) {
          this.current = undefined;
        }
      });
    this.current = read;
    return read;
  }
}

/**
 * One read of a socket table. The first lookups that share it each search it
 * for their own row. Past SEARCHES_BEFORE_INDEX, one pass indexes every row a
 * process can hold by its local port, so a read shared by a burst of lookups
 * is not searched once per lookup.
 */
class TcpTable {
  private searches = 0;
  private byPort?: Map<number, TcpRow[]>;

  constructor(private readonly text: string) {}

  inode(port: number, remotePort: number | undefined): string | undefined {
    if (this.byPort === undefined && this.searches < SEARCHES_BEFORE_INDEX) {
      this.searches += 1;
      return parseProcNetTcpInode(this.text, port, remotePort);
    }
    this.byPort ??= tcpRowsByPort(this.text);
    return pickInode(this.byPort.get(port) ?? [], remotePort);
  }
}

// Fewest descriptors first; between equals, the lower pid.
function byRank(a: { readonly pid: number; readonly rank: number }, b: { readonly pid: number; readonly rank: number }): number {
  return a.rank - b.rank || a.pid - b.pid;
}

const LINK_BATCH = 64;

// Reads a process's descriptors from the highest number down, a batch at a
// time. A process that holds many long-lived descriptors gets its newest
// socket above them, so the one just connected is in the first batch.
async function heldSocket(
  proc: ProcFs,
  pid: number,
  fds: readonly string[],
  targets: ReadonlyMap<string, string>,
  open?: () => boolean,
): Promise<{ inode: string; fd: string } | undefined> {
  const dir = `${proc.root}/${pid}/fd`;
  const newestFirst = [...fds].sort((a, b) => Number(b) - Number(a));
  for (let start = 0; start < newestFirst.length; start += LINK_BATCH) {
    if (start > 0 && open?.() === false) {
      return undefined;
    }
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
  return pickInode(rowsOnPort(text, port), remotePort);
}

type TcpRow = { readonly port: number; readonly remotePort: number; readonly inode: string; readonly established: boolean };

function* rowsOnPort(text: string, port: number): Generator<TcpRow> {
  const needle = `:${port.toString(16).toUpperCase().padStart(4, "0")} `;
  for (let at = text.indexOf(needle); at >= 0; ) {
    const start = text.lastIndexOf("\n", at) + 1;
    const newline = text.indexOf("\n", at);
    const end = newline < 0 ? text.length : newline;
    const row = parseTcpRow(text.slice(start, end));
    if (row?.port === port) {
      yield row;
    }
    at = newline < 0 ? -1 : text.indexOf(needle, newline);
  }
}

/**
 * Every row of a socket table that a process can hold, by local port, in
 * table order. Rows in TIME_WAIT, most of a table under connection churn, are
 * passed over by their state column without being split.
 */
export function tcpRowsByPort(text: string): Map<number, TcpRow[]> {
  const byPort = new Map<number, TcpRow[]>();
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const row = inTimeWait(text, start, end) ? undefined : parseTcpRow(text.slice(start, end));
    if (row !== undefined) {
      const rows = byPort.get(row.port);
      if (rows === undefined) {
        byPort.set(row.port, [row]);
      } else {
        rows.push(row);
      }
    }
    start = end + 1;
  }
  return byPort;
}

// The kernel writes a row as `slot: local remote state ...`: only the slot
// ends in ": ", and one space separates the next three columns. A row laid
// out any other way is not passed over here, only parsed in full.
function inTimeWait(text: string, start: number, end: number): boolean {
  const slot = text.indexOf(": ", start);
  if (slot < 0 || slot >= end) {
    return false;
  }
  const local = text.indexOf(" ", slot + 2);
  const remote = local < 0 || local >= end ? -1 : text.indexOf(" ", local + 1);
  return remote >= 0 && remote + 3 < end && text.startsWith("06 ", remote + 1);
}

// Of the rows on one local port, the first ESTABLISHED one, else the first.
function pickInode(rows: Iterable<TcpRow>, remotePort: number | undefined): string | undefined {
  let fallback: TcpRow | undefined;
  for (const row of rows) {
    if (remotePort !== undefined && row.remotePort !== remotePort) {
      continue;
    }
    if (row.established) {
      return standalone(row.inode);
    }
    fallback ??= row;
  }
  return fallback === undefined ? undefined : standalone(fallback.inode);
}

// The resolver caches an inode for as long as the connection lives. Cut from
// the table it would keep the whole table text alive, one per cached socket;
// a copy stands on its own.
function standalone(inode: string): string {
  return Buffer.from(inode, "latin1").toString("latin1");
}

function parseTcpRow(line: string): TcpRow | undefined {
  const cols = line.trim().split(/\s+/);
  const local = cols[1] ?? "";
  // Skip the header (`local_address`) and blank lines: a real row is `hex:hex`.
  if (!/^[0-9A-Fa-f]+:[0-9A-Fa-f]+$/.test(local)) {
    return undefined;
  }
  const inode = cols[9] ?? "";
  if (!/^[0-9]+$/.test(inode) || inode === "0") {
    return undefined;
  }
  return { port: addressPort(local), remotePort: addressPort(cols[2] ?? ""), inode, established: (cols[3] ?? "").toUpperCase() === "01" };
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
  process.platform === "linux" ? { proc: nodeProcFs(), lookups: shellLookups, openKernel: openSocketDiag } : { lookups: shellLookups },
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
