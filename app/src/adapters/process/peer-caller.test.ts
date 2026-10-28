import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { gcAndSweep, heapStats } from "bun:jsc";
import {
  callerServiceForPeer,
  managedCallers,
  nodeProcFs,
  parseLsofLocalTcpOwner,
  parseNetstatLocalTcpOwner,
  parseProcNetTcpInode,
  parseProcPidStat,
  parsePsPidColumn,
  PeerCallerResolver,
  tcpRowsByPort,
  type PeerCallerLookups,
  type ProcFs,
} from "./peer-caller.ts";
import type { SocketAnswer, SocketDiag } from "./sock-diag.ts";

const lookups = (owner: number | undefined, ancestors: number[], pgid?: number): PeerCallerResolver =>
  new PeerCallerResolver({
    lookups: {
      ownerPidForPort: async () => owner,
      ancestorPids: async () => ancestors,
      processGroupId: async () => pgid,
    } satisfies PeerCallerLookups,
  });

describe("peer TCP owner parsers", () => {
  test("picks the process whose local port matches, not the proxy on the remote side", () => {
    const text = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "devctl  1000 amr   12u  IPv4 0x1      0t0  TCP 127.0.0.1:17400->127.0.0.1:54321 (ESTABLISHED)",
      "node    4242 amr   23u  IPv4 0x2      0t0  TCP 127.0.0.1:54321->127.0.0.1:17400 (ESTABLISHED)",
    ].join("\n");
    expect(parseLsofLocalTcpOwner(text, 54321)).toBe(4242);
    expect(parseLsofLocalTcpOwner(text, 17400)).toBe(1000);
    expect(parseLsofLocalTcpOwner(text, 9)).toBeUndefined();
  });

  test("parses an ESTABLISHED netstat row by local port", () => {
    const text = [
      "  TCP    127.0.0.1:17400    127.0.0.1:54321    ESTABLISHED    1000",
      "  TCP    127.0.0.1:54321    127.0.0.1:17400    ESTABLISHED    4242",
      "  TCP    127.0.0.1:54321    0.0.0.0:0          LISTENING      9",
    ].join("\n");
    expect(parseNetstatLocalTcpOwner(text, 54321)).toBe(4242);
    expect(parsePsPidColumn("    77\n")).toBe(77);
    expect(parsePsPidColumn("")).toBeUndefined();
  });
});

describe("proc parsers (lsof/ps-free path)", () => {
  // 0xD431 = 54321 (client ephemeral), 0x43F8 = 17400 (proxy listen).
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:D431 0100007F:43F8 01 00000000:00000000 00:00000000 00000000  1000        0 45678 1 0000 100 0 0 10 0",
    "   1: 0100007F:43F8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000 100 0 0 10 0",
  ].join("\n");

  test("resolves the inode by local port, never the remote", () => {
    // The service socket (local D431) wins; the proxy socket (local 43F8, remote
    // D431) must not be picked when searching for the client port.
    expect(parseProcNetTcpInode(tcp, 0xd431)).toBe("45678");
    expect(parseProcNetTcpInode(tcp, 0x43f8)).toBe("11111");
    expect(parseProcNetTcpInode(tcp, 0x1234)).toBeUndefined();
  });

  test("reads an IPv4-mapped tcp6 row", () => {
    const tcp6 = [
      "  sl  local_address                         rem_address                        st ... inode",
      "   0: 0000000000000000FFFF00000100007F:D431 0000000000000000FFFF00000100007F:43F8 01 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000 100 0 0 10 0",
    ].join("\n");
    expect(parseProcNetTcpInode(tcp6, 0xd431)).toBe("99999");
  });

  test("indexes every row a process can hold by its local port, passing over TIME_WAIT", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:D431 0100007F:43F8 06 00000000:00000000 03:00000F3C 00000000     0        0 0 3 0000000000000000",
      "   1: 0100007F:D431 0100007F:1F90 08 00000000:00000000 00:00000000 00000000  1000        0 45679 1 0000 100 0 0 10 0",
      "   2: 0100007F:D431 0100007F:43F8 01 00000000:00000000 00:00000000 00000000  1000        0 45678 1 0000 100 0 0 10 0",
      "   3: 0100007F:43F8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000 100 0 0 10 0",
      // Closed by its process and still draining: no inode.
      "   4: 0100007F:D432 0100007F:43F8 04 00000000:00000000 01:00000014 00000000  1000        0 0 1 0000 100 0 0 10 0",
      "10000: 0000000000000000FFFF00000100007F:D433 0000000000000000FFFF00000100007F:43F8 01 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000 100 0 0 10 0",
      "10001: 0000000000000000FFFF00000100007F:D434 0000000000000000FFFF00000100007F:43F8 06 00000000:00000000 03:00000F3C 00000000     0        0 0 3 0000000000000000",
    ].join("\n");
    const index = tcpRowsByPort(text);
    expect([...index.keys()].sort((a, b) => a - b)).toEqual([0x43f8, 0xd431, 0xd433]);
    expect(index.get(0xd431)).toEqual([
      { port: 0xd431, remotePort: 0x1f90, inode: "45679", established: false },
      { port: 0xd431, remotePort: 0x43f8, inode: "45678", established: true },
    ]);
    expect(index.get(0xd433)?.map((row) => row.inode)).toEqual(["99999"]);
    // A search of the table finds the same rows.
    expect(parseProcNetTcpInode(text, 0xd431)).toBe("45678");
    expect(parseProcNetTcpInode(text, 0xd431, 0x1f90)).toBe("45679");
    expect(parseProcNetTcpInode(text, 0xd432)).toBeUndefined();
  });

  test("prefers an ESTABLISHED row and skips inode 0 (TIME_WAIT)", () => {
    const rows = [
      "   0: 0100007F:D431 0100007F:43F8 08 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000 100 0 0 10 0",
      "   1: 0100007F:D431 0100007F:43F8 06 00000000:00000000 00:00000000 00000000     0        0 0 0 0000 100 0 0 10 0",
      "   2: 0100007F:D431 0100007F:43F8 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000 100 0 0 10 0",
    ].join("\n");
    expect(parseProcNetTcpInode(rows, 0xd431)).toBe("33333");
  });

  test("parses ppid/pgid from /proc/<pid>/stat, tolerating parens in comm", () => {
    expect(parseProcPidStat("100 (python3) S 50 40 40 0 -1 4194560 1 0 0 0")).toEqual({ ppid: 50, pgid: 40 });
    // comm renamed with spaces and an embedded ')': fields still read after the last ')'.
    expect(parseProcPidStat("4242 (uv run (py)) S 4200 4100 4100 0 -1 0 0")).toEqual({ ppid: 4200, pgid: 4100 });
    expect(parseProcPidStat("garbage-without-parens")).toBeUndefined();
  });
});

describe("what a parsed inode keeps alive", () => {
  // Memory freed late by earlier tests would skew one reading, so collect until two agree.
  function settledHeap(): number {
    let previous = Number.NaN;
    for (let round = 0; round < 10; round += 1) {
      gcAndSweep();
      const current = heapStats().heapSize;
      if (Math.abs(current - previous) < 64 * 1024) {
        return current;
      }
      previous = current;
    }
    return previous;
  }

  // /proc/net/tcp for a host with `rows` sockets; the last row is the one asked for.
  function table(rows: number, port: number, inode: number): string {
    let text = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    for (let row = 0; row < rows; row += 1) {
      const last = row === rows - 1;
      const local = (last ? port : 20_000 + row).toString(16).toUpperCase().padStart(4, "0");
      text += `${String(row).padStart(4)}: 0100007F:${local} 0100007F:${(40_000 + row).toString(16).toUpperCase()} 01 00000000:00000000 00:00000000 00000000  1000        0 ${last ? inode : 900_000 + row} 1 0000000000000000 20 4 30 10 -1\n`;
    }
    return text;
  }

  test("the inode stands on its own: keeping it does not keep the socket table it was read from", () => {
    // The resolver keeps one inode per cached socket, up to 4,096 of them.
    const kept: string[] = [];
    const tableBytes = table(600, 30_000, 1).length;
    expect(tableBytes).toBeGreaterThan(64 * 1024);
    const before = settledHeap();
    for (let index = 0; index < 300; index += 1) {
      kept.push(parseProcNetTcpInode(table(600, 30_000 + index, 500_000 + index), 30_000 + index) ?? "");
    }
    const grew = settledHeap() - before;
    expect(kept).toEqual(Array.from({ length: 300 }, (_, index) => String(500_000 + index)));
    // Cut from the table, each inode kept its 77 KiB table: 22 MiB for these 300.
    expect(grew).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("callerServiceForPeer", () => {
  test("ignores non-loopback peers so a remote source port cannot match a local pid", async () => {
    const found = await callerServiceForPeer(
      { address: "8.8.8.8", port: 54321 },
      () => [{ name: "api", pid: 4242 }],
      lookups(4242, [4242]),
    );
    expect(found).toBeUndefined();
  });

  test("matches the owning pid, then a parent, then the process group", async () => {
    const services = () => [
      { name: "api", pid: 100 },
      { name: "worker", pid: 200 },
    ];
    expect(await callerServiceForPeer({ address: "127.0.0.1", port: 9 }, services, lookups(100, [100]))).toBe("api");
    expect(await callerServiceForPeer({ address: "::1", port: 9 }, services, lookups(999, [999, 200]))).toBe("worker");
    expect(await callerServiceForPeer({ address: "127.0.0.1", port: 9 }, services, lookups(999, [999], 100))).toBe("api");
    expect(await callerServiceForPeer({ address: "127.0.0.1", port: 9 }, services, lookups(999, [999], 1))).toBeUndefined();
  });
});

type FakeProcess = { pid: number; ppid: number; pgid?: number; sockets?: string[]; files?: number; start?: number };

// A /proc/<pid>/stat line: state, ppid, pgrp, session, ... with the start time as field 22.
function statLine(proc: FakeProcess): string {
  const pgid = proc.pgid ?? proc.pid;
  return `${proc.pid} (svc) S ${proc.ppid} ${pgid} ${pgid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${proc.start ?? proc.pid} 0 0`;
}

// A /proc tree on disk: stat files, fd symlinks, and a net/tcp table.
function fakeProc() {
  const root = mkdtempSync(join(tmpdir(), "devctl-proc-"));
  mkdirSync(join(root, "net"));
  const rows: string[] = [];
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const writeTcp = (): void => writeFileSync(join(root, "net", "tcp"), `${[header, ...rows].join("\n")}\n`);
  writeTcp();
  return {
    root,
    add(proc: FakeProcess): void {
      const fds = join(root, String(proc.pid), "fd");
      mkdirSync(fds, { recursive: true });
      writeFileSync(join(root, String(proc.pid), "stat"), statLine(proc));
      let fd = 0;
      for (let i = 0; i < (proc.files ?? 0); i += 1) {
        symlinkSync("/dev/null", join(fds, String(fd++)));
      }
      for (const inode of proc.sockets ?? []) {
        symlinkSync(`socket:[${inode}]`, join(fds, String(fd++)));
      }
    },
    socket(port: number, inode: string, remotePort = PROXY_PORT): void {
      const hex = (value: number): string => value.toString(16).toUpperCase().padStart(4, "0");
      rows.push(`   ${rows.length}: 0100007F:${hex(port)} 0100007F:${hex(remotePort)} 01 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000 100 0 0 10 0`);
      writeTcp();
    },
    clearSockets(): void {
      rows.length = 0;
      writeTcp();
    },
    /** The process now at this pid: a new start time, parent or group. */
    restat(proc: FakeProcess): void {
      writeFileSync(join(root, String(proc.pid), "stat"), statLine(proc));
    },
    /** Opens `count` more descriptors in `pid`, from descriptor `from`. */
    grow(pid: number, from: number, count: number): void {
      for (let fd = from; fd < from + count; fd += 1) {
        symlinkSync("/dev/null", join(root, String(pid), "fd", String(fd)));
      }
    },
    /** Puts socket `inode` at descriptor `fd` of `pid`, or closes that descriptor. */
    hold(pid: number, fd: number, inode: string | undefined): void {
      const path = join(root, String(pid), "fd", String(fd));
      rmSync(path, { force: true });
      if (inode !== undefined) {
        symlinkSync(`socket:[${inode}]`, path);
      }
    },
    close(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Counts what the resolver reads, per path.
function counting(proc: ProcFs) {
  const listed: string[] = [];
  const linked: string[] = [];
  const counts = { links: 0, tables: 0 };
  const fs: ProcFs = {
    root: proc.root,
    readText: async (path) => {
      if (path.endsWith("/net/tcp")) {
        counts.tables += 1;
      }
      return proc.readText(path);
    },
    list: async (path) => {
      listed.push(path);
      return proc.list(path);
    },
    link: async (path) => {
      counts.links += 1;
      linked.push(path);
      return proc.link(path);
    },
  };
  return { fs, listed, linked, counts };
}

const CLIENT_PORT = 0xd431;
const PROXY_PORT = 0x43f8;
const peer = { address: "127.0.0.1", port: CLIENT_PORT };
const services = () => [{ name: "api", pid: 100 }];

describe.skipIf(process.platform === "win32")("PeerCallerResolver on /proc", () => {
  function world() {
    const proc = fakeProc();
    // The daemon holds the proxy's side of every connection and many more fds.
    proc.add({ pid: 50, ppid: 1, files: 300, sockets: ["11111"] });
    proc.add({ pid: 100, ppid: 50, files: 2 });
    proc.add({ pid: 101, ppid: 100, pgid: 100, sockets: ["45678"] });
    proc.add({ pid: 300, ppid: 1, sockets: ["77777"] });
    proc.socket(CLIENT_PORT, "45678");
    proc.socket(0x43f8, "11111");
    return proc;
  }

  test("finds the socket in a managed service's child without reading any other process's fds", async () => {
    const proc = world();
    try {
      const reads = counting(nodeProcFs(proc.root));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0 });
      expect(await callerServiceForPeer(peer, services, resolver)).toBe("api");
      expect(reads.listed).not.toContain(`${proc.root}/50/fd`);
      expect(reads.listed).not.toContain(`${proc.root}/300/fd`);
    } finally {
      proc.close();
    }
  });

  test("reads the smallest managed process first, so one holding thousands of fds does not delay the caller", async () => {
    const proc = fakeProc();
    try {
      // "hog" holds 3,000 descriptors and none of them is the peer's socket.
      proc.add({ pid: 200, ppid: 1, files: 3_000 });
      proc.add({ pid: 100, ppid: 1, files: 4, sockets: ["45678"] });
      proc.socket(CLIENT_PORT, "45678");
      const reads = counting(nodeProcFs(proc.root));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0 });
      const both = () => [{ name: "hog", pid: 200 }, { name: "api", pid: 100 }];
      expect(await callerServiceForPeer(peer, both, resolver)).toBe("api");
      // Only the small process's links were read.
      expect(reads.counts.links).toBeLessThan(10);
    } finally {
      proc.close();
    }
  });

  test("finds a socket just opened by a process that holds thousands of fds in its first batch", async () => {
    const proc = fakeProc();
    try {
      // The new socket sits above 3,000 long-lived descriptors.
      proc.add({ pid: 200, ppid: 1, files: 3_000, sockets: ["45678"] });
      proc.socket(CLIENT_PORT, "45678");
      const reads = counting(nodeProcFs(proc.root));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0 });
      expect(await callerServiceForPeer(peer, () => [{ name: "hog", pid: 200 }], resolver)).toBe("hog");
      expect(reads.counts.links).toBeLessThanOrEqual(64);
    } finally {
      proc.close();
    }
  });

  test("a warm lookup on the same socket reads no fds, and a reused port resolves again", async () => {
    const proc = world();
    try {
      const reads = counting(nodeProcFs(proc.root));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0 });
      expect(await callerServiceForPeer(peer, services, resolver)).toBe("api");
      reads.counts.links = 0;
      reads.listed.length = 0;
      expect(await callerServiceForPeer(peer, services, resolver)).toBe("api");
      expect(reads.counts.links).toBe(0);
      expect(reads.listed.filter((path) => path.endsWith("/fd"))).toEqual([]);
      // The port now belongs to a new socket held by a process devctl does not manage.
      proc.clearSockets();
      proc.socket(CLIENT_PORT, "77777");
      expect(await callerServiceForPeer(peer, services, resolver)).toBeUndefined();
      expect(reads.listed).not.toContain(`${proc.root}/300/fd`);
    } finally {
      proc.close();
    }
  });

  test("the proxy's side picks the client's connection over its socket to another destination on the same port", async () => {
    const proc = world();
    try {
      proc.clearSockets();
      // Process 300 reuses the client port for a connection elsewhere; its row comes first.
      proc.socket(CLIENT_PORT, "77777", 0x1f90);
      proc.socket(CLIENT_PORT, "45678");
      const resolver = new PeerCallerResolver({ proc: nodeProcFs(proc.root), now: () => 0 });
      expect(await callerServiceForPeer({ ...peer, proxyPort: PROXY_PORT }, services, resolver)).toBe("api");
      expect(await callerServiceForPeer(peer, services, resolver)).toBeUndefined();
    } finally {
      proc.close();
    }
  });

  test("with the proxy's side known, a repeat lookup checks one fd link and reads no tcp table", async () => {
    const proc = world();
    try {
      const reads = counting(nodeProcFs(proc.root));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0 });
      const known = { ...peer, proxyPort: PROXY_PORT };
      expect(await callerServiceForPeer(known, services, resolver)).toBe("api");
      reads.counts.links = 0;
      reads.counts.tables = 0;
      expect(await callerServiceForPeer(known, services, resolver)).toBe("api");
      expect(reads.counts).toEqual({ links: 1, tables: 0 });
      // Once its holder closes the socket, the table decides again.
      rmSync(join(proc.root, "101", "fd", "0"));
      proc.clearSockets();
      expect(await callerServiceForPeer(known, services, resolver)).toBeUndefined();
      expect(reads.counts.tables).toBe(1);
    } finally {
      proc.close();
    }
  });

  test("concurrent lookups for one port share one resolution", async () => {
    const proc = world();
    try {
      const reads = counting(nodeProcFs(proc.root));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0 });
      const both = await Promise.all([callerServiceForPeer(peer, services, resolver), callerServiceForPeer(peer, services, resolver)]);
      expect(both).toEqual(["api", "api"]);
      expect(reads.counts.tables).toBe(1);
    } finally {
      proc.close();
    }
  });

  test("a child started after the index was built is found on a later miss or a start signal", async () => {
    const proc = world();
    try {
      let now = 0;
      const resolver = new PeerCallerResolver({ proc: nodeProcFs(proc.root), now: () => now });
      expect(await callerServiceForPeer(peer, services, resolver)).toBe("api");
      proc.add({ pid: 102, ppid: 100, sockets: ["55555"] });
      proc.socket(0xd432, "55555");
      const late = { address: "127.0.0.1", port: 0xd432 };
      // Too soon after the last rebuild: the miss is not cached past the next one.
      expect(await callerServiceForPeer(late, services, resolver)).toBeUndefined();
      now = 300;
      expect(await callerServiceForPeer(late, services, resolver)).toBe("api");

      proc.add({ pid: 103, ppid: 101, sockets: ["66666"] });
      proc.socket(0xd433, "66666");
      resolver.markDirty();
      expect(await callerServiceForPeer({ address: "127.0.0.1", port: 0xd433 }, services, resolver)).toBe("api");
    } finally {
      proc.close();
    }
  });

  // The kernel's socket lookup, knowing the sockets in `open` by "<local port>><remote port>".
  function fakeKernel(open: ReadonlyMap<string, SocketAnswer>) {
    const asked: string[] = [];
    const kernel: SocketDiag = {
      socket: (local, remote) => {
        const key = `${local.port}>${remote.port}`;
        asked.push(key);
        return open.get(key) ?? "missing";
      },
    };
    return { kernel, asked };
  }

  const viaProxy = (port: number) => ({ address: "127.0.0.1", port, proxyPort: PROXY_PORT, proxyAddress: "127.0.0.1" });

  // Pid 101, a child of the managed pid 100, holds a socket on each of `count` new client ports.
  function churned(count: number) {
    const proc = fakeProc();
    const ports = Array.from({ length: count }, (_, index) => 0xd500 + index);
    const inodes = ports.map((_, index) => String(60_000 + index));
    proc.add({ pid: 100, ppid: 50, files: 2 });
    proc.add({ pid: 101, ppid: 100, pgid: 100, sockets: inodes });
    ports.forEach((port, index) => proc.socket(port, inodes[index]!));
    return { proc, ports, open: new Map<string, SocketAnswer>(ports.map((port, index) => [`${port}>${PROXY_PORT}`, { inode: inodes[index]! }])) };
  }

  test("with the kernel's socket lookup, a new connection costs no read of the socket table", async () => {
    const { proc, ports, open } = churned(30);
    try {
      const reads = counting(nodeProcFs(proc.root));
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => kernel.kernel });
      for (const port of ports) {
        expect(await callerServiceForPeer(viaProxy(port), services, resolver)).toBe("api");
      }
      // Read once per connection, the table took a whole copy of every socket each time.
      expect(reads.counts.tables).toBe(0);
      // Asked about each connection (again while its scan runs, to stop once it has closed).
      expect(new Set(kernel.asked).size).toBe(30);
    } finally {
      proc.close();
    }
  });

  test("once the kernel has answered for the proxy's own end, its 'no such socket' is believed", async () => {
    const { proc, ports } = churned(3);
    try {
      const reads = counting(nodeProcFs(proc.root));
      // The client has gone; only the proxy's end of each connection is known.
      const kernel = fakeKernel(new Map(ports.map((port) => [`${PROXY_PORT}>${port}`, { inode: "1" }])));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => kernel.kernel });
      for (const port of ports) {
        expect(await callerServiceForPeer(viaProxy(port), services, resolver)).toBeUndefined();
      }
      expect(reads.counts.tables).toBe(0);
      // The proxy's end was asked about only until the kernel had proved itself.
      expect(kernel.asked).toEqual([`${ports[0]}>${PROXY_PORT}`, `${PROXY_PORT}>${ports[0]}`, `${ports[1]}>${PROXY_PORT}`, `${ports[2]}>${PROXY_PORT}`]);
      // A connection the kernel knows only in TIME_WAIT is closed, whatever the table says.
      const timeWait = fakeKernel(new Map([[`${ports[0]}>${PROXY_PORT}`, "closed" as const]]));
      const fresh = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => timeWait.kernel });
      expect(await callerServiceForPeer(viaProxy(ports[0]!), services, fresh)).toBeUndefined();
      expect(reads.counts.tables).toBe(0);
    } finally {
      proc.close();
    }
  });

  test("a kernel that cannot prove its answers is given up on, and the socket table answers", async () => {
    const { proc, ports } = churned(6);
    try {
      const reads = counting(nodeProcFs(proc.root));
      // A kernel without the lookup: every socket is missing, the proxy's own included.
      const kernel = fakeKernel(new Map());
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => kernel.kernel });
      for (const port of ports) {
        expect(await callerServiceForPeer(viaProxy(port), services, resolver)).toBe("api");
      }
      expect(reads.counts.tables).toBe(6);
      // Asked about the client and the proxy's end for three connections, then not again.
      expect(kernel.asked).toHaveLength(6);
      // A lookup the kernel could not open, or one without the proxy's address, reads the table too.
      const unopened = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => undefined });
      expect(await callerServiceForPeer(viaProxy(ports[0]!), services, unopened)).toBe("api");
      const known = fakeKernel(new Map([[`${ports[1]}>${PROXY_PORT}`, { inode: "60001" }]]));
      const noAddress = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => known.kernel });
      expect(await callerServiceForPeer({ address: "127.0.0.1", port: ports[1]!, proxyPort: PROXY_PORT }, services, noAddress)).toBe("api");
      expect(known.asked).toEqual([]);
      expect(reads.counts.tables).toBe(8);
      // Ends the kernel cannot be asked about are no reason to give up on it.
      const picky: SocketDiag = { socket: (local, remote) => (local.port === ports[1] ? known.kernel.socket(local, remote) : "unasked") };
      const keeps = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => picky });
      for (const port of ports.slice(2)) {
        expect(await callerServiceForPeer(viaProxy(port), services, keeps)).toBe("api");
      }
      expect(reads.counts.tables).toBe(12);
      expect(await callerServiceForPeer(viaProxy(ports[1]!), services, keeps)).toBe("api");
      expect(reads.counts.tables).toBe(12);
      expect([...new Set(known.asked)]).toEqual([`${ports[1]}>${PROXY_PORT}`]);
    } finally {
      proc.close();
    }
  });

  // Each read of net/tcp copies the table when it is asked for and hands it over once `release` is called.
  function heldReads(proc: ProcFs) {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counts = { tables: 0 };
    const fs: ProcFs = {
      ...proc,
      readText: async (path) => {
        if (!path.endsWith("/net/tcp")) {
          return proc.readText(path);
        }
        counts.tables += 1;
        const text = await proc.readText(path);
        await gate;
        return text;
      },
    };
    return { fs, counts, release: () => release() };
  }

  test("without the kernel's lookup, connections that arrive during a read of the table share the next one", async () => {
    const { proc, ports } = churned(12);
    try {
      const reads = heldReads(nodeProcFs(proc.root));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0 });
      const first = callerServiceForPeer(viaProxy(ports[0]!), services, resolver);
      await Bun.sleep(10);
      expect(reads.counts.tables).toBe(1);
      const rest = ports.slice(1).map((port) => callerServiceForPeer(viaProxy(port), services, resolver));
      await Bun.sleep(10);
      reads.release();
      // Eleven lookups on one read: past the first few, the table is indexed once.
      const callers: (string | undefined)[] = await Promise.all([first, ...rest]);
      expect(callers).toEqual(ports.map(() => "api"));
      expect(reads.counts.tables).toBe(2);
    } finally {
      proc.close();
    }
  });

  test("a lookup is never answered from a read of the table that began before it asked", async () => {
    const proc = fakeProc();
    try {
      proc.add({ pid: 100, ppid: 1, sockets: ["80001", "80002"] });
      proc.socket(0xd601, "80001");
      const reads = heldReads(nodeProcFs(proc.root));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0 });
      const early = callerServiceForPeer(viaProxy(0xd601), services, resolver);
      await Bun.sleep(10);
      // This connection opened after the read under way had copied the table.
      proc.socket(0xd602, "80002");
      const late = callerServiceForPeer(viaProxy(0xd602), services, resolver);
      reads.release();
      expect(await Promise.all([early, late])).toEqual(["api", "api"]);
      expect(reads.counts.tables).toBe(2);
    } finally {
      proc.close();
    }
  });

  // The daemon (50), a small managed service (100), a managed service holding
  // 3,000 descriptors (200), a process devctl does not run that never calls
  // (300), and a client devctl does not run (400) that opens one connection
  // after another, each at its lowest free descriptor, 10.
  function churnWorld() {
    const proc = fakeProc();
    proc.add({ pid: 50, ppid: 1, files: 300 });
    proc.add({ pid: 100, ppid: 50, files: 4 });
    proc.add({ pid: 200, ppid: 50, files: 3_000 });
    proc.add({ pid: 300, ppid: 1, files: 6 });
    proc.add({ pid: 400, ppid: 1, files: 10 });
    const open = new Map<string, SocketAnswer>();
    let made = 0;
    const connect = (pid = 400, fd = 10): ReturnType<typeof viaProxy> => {
      made += 1;
      const port = 0xd700 + made;
      const inode = String(90_000 + made);
      proc.hold(pid, fd, inode);
      open.set(`${port}>${PROXY_PORT}`, { inode });
      return viaProxy(port);
    };
    return { proc, open, connect };
  }
  const churnServices = () => [{ name: "api", pid: 100 }, { name: "hog", pid: 200 }];
  const onlyFrom = (paths: readonly string[], pid: number): string[] => paths.filter((path) => path.includes(`/${pid}/fd`));

  test("a client devctl does not run is read first once found, so its next connections read none of the managed processes' descriptors", async () => {
    const { proc, open, connect } = churnWorld();
    try {
      const reads = counting(nodeProcFs(proc.root));
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => kernel.kernel, self: 50 });
      // The first misses every managed process. The second searches the
      // processes devctl does not run while its socket is open, and finds the client.
      expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
      expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
      expect(onlyFrom(reads.linked, 200).length).toBeGreaterThanOrEqual(6_000);
      reads.counts.links = 0;
      reads.linked.length = 0;
      reads.listed.length = 0;
      for (let index = 0; index < 20; index += 1) {
        expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
      }
      // One link a connection: the client's descriptor 10. Read every time, the 3,000 were 60,000.
      expect(reads.counts.links).toBe(20);
      expect(reads.linked.every((path) => path.endsWith("/400/fd/10"))).toBe(true);
      // Small directories are listed beside that read; the one holding 3,000 never is.
      expect(reads.listed).not.toContain(`${proc.root}/200/fd`);
      // The process that never called was read at most once, by the search.
      expect(onlyFrom(reads.linked, 300)).toEqual([]);
    } finally {
      proc.close();
    }
  });

  test("without the kernel's lookup, the client is still found and read first, from the socket table's inodes", async () => {
    const { proc } = churnWorld();
    try {
      let made = 0;
      // Each connection's socket is in the table, at the client's descriptor 10.
      const connect = (): ReturnType<typeof viaProxy> => {
        made += 1;
        const port = 0xda00 + made;
        const inode = String(97_000 + made);
        proc.hold(400, 10, inode);
        proc.socket(port, inode);
        return viaProxy(port);
      };
      const reads = counting(nodeProcFs(proc.root));
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0, self: 50 });
      expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
      expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
      reads.linked.length = 0;
      for (let index = 0; index < 10; index += 1) {
        expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
      }
      expect(reads.linked).toEqual(Array.from({ length: 10 }, () => `${proc.root}/400/fd/10`));
    } finally {
      proc.close();
    }
  });

  test("the client is found while the managed scan is still reading, even when its connection closes before that scan ends", async () => {
    const { proc, open, connect } = churnWorld();
    try {
      const inner = nodeProcFs(proc.root);
      let gated = false;
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let seen = (): void => undefined;
      const clientRead = new Promise<void>((resolve) => {
        seen = resolve;
      });
      const linked: string[] = [];
      // The managed process's descriptors are read slowly; a read of the client's is noticed once it is done.
      const fs: ProcFs = {
        ...inner,
        link: async (path) => {
          linked.push(path);
          if (gated && path.includes("/200/fd/")) {
            await gate;
          }
          const target = await inner.link(path);
          if (path.endsWith("/400/fd/10")) {
            seen();
          }
          return target;
        },
      };
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: fs, now: () => 0, openKernel: async () => kernel.kernel, self: 50 });
      try {
        expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
        gated = true;
        const second = callerServiceForPeer(connect(), churnServices, resolver);
        const readInTime = await Promise.race([clientRead.then(() => true), Bun.sleep(2_000).then(() => false)]);
        expect(readInTime).toBe(true);
        // The client closes this connection while the scan is held inside the managed process.
        proc.hold(400, 10, undefined);
        release();
        expect(await second).toBeUndefined();
        linked.length = 0;
        expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
        expect(onlyFrom(linked, 200)).toEqual([]);
      } finally {
        release();
      }
    } finally {
      proc.close();
    }
  });

  test("a scan stops once the kernel says the connection has closed: no process can hold it any more", async () => {
    const { proc, open, connect } = churnWorld();
    try {
      const inner = nodeProcFs(proc.root);
      const linked: string[] = [];
      let closing = "";
      // The client closes its connection while the small service is being read.
      const fs: ProcFs = {
        ...inner,
        link: async (path) => {
          linked.push(path);
          if (path.includes("/100/fd/")) {
            open.delete(closing);
          }
          return inner.link(path);
        },
      };
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: fs, now: () => 0, openKernel: async () => kernel.kernel, self: 50 });
      const peer = connect();
      closing = `${peer.port}>${PROXY_PORT}`;
      expect(await callerServiceForPeer(peer, churnServices, resolver)).toBeUndefined();
      // Read while open, the 3,000 descriptors were read in full.
      expect(onlyFrom(linked, 100).length).toBeGreaterThan(0);
      expect(onlyFrom(linked, 200)).toEqual([]);
    } finally {
      proc.close();
    }
  });

  test("a hot owner is judged afresh: once adopted as a service, or when its pid now names a service's child", async () => {
    const { proc, open, connect } = churnWorld();
    try {
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: nodeProcFs(proc.root), now: () => 0, openKernel: async () => kernel.kernel, self: 50 });
      for (let index = 0; index < 3; index += 1) {
        expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
      }
      // devctl adopts the client as a service.
      resolver.markDirty();
      const adopted = () => [...churnServices(), { name: "late", pid: 400 }];
      expect(await callerServiceForPeer(connect(), adopted, resolver)).toBe("late");
      // The client exits and its pid is reused by a child of "api".
      proc.restat({ pid: 400, ppid: 100, start: 9_999 });
      expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBe("api");
    } finally {
      proc.close();
    }
  });

  test("while a hot owner is kept, a managed caller in a smaller service reads nothing of it but its last descriptor", async () => {
    const { proc, open, connect } = churnWorld();
    try {
      let now = 0;
      const reads = counting(nodeProcFs(proc.root));
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => now, openKernel: async () => kernel.kernel, self: 50 });
      for (let index = 0; index < 3; index += 1) {
        expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
      }
      // Late enough that no lookup missed recently, so no search for an owner
      // runs beside the scan, and soon enough that the hot owner is kept.
      now = 6_000;
      reads.linked.length = 0;
      reads.listed.length = 0;
      // "api" (5 descriptors) opens a connection of its own; the client holds 11.
      expect(await callerServiceForPeer(connect(100, 4), churnServices, resolver)).toBe("api");
      expect(onlyFrom(reads.linked, 400)).toEqual([`${proc.root}/400/fd/10`]);
      expect(onlyFrom(reads.linked, 200)).toEqual([]);
    } finally {
      proc.close();
    }
  });

  test("a managed caller in a small service is read before a hot owner holding even fewer descriptors", async () => {
    const proc = fakeProc();
    try {
      let now = 0;
      // "api" holds 20 descriptors, the client 3.
      proc.add({ pid: 100, ppid: 1, files: 20 });
      proc.add({ pid: 400, ppid: 1, files: 2 });
      const open = new Map<string, SocketAnswer>();
      let made = 0;
      const connect = (pid: number, fd: number): ReturnType<typeof viaProxy> => {
        made += 1;
        const port = 0xd900 + made;
        proc.hold(pid, fd, String(95_000 + made));
        open.set(`${port}>${PROXY_PORT}`, { inode: String(95_000 + made) });
        return viaProxy(port);
      };
      const reads = counting(nodeProcFs(proc.root));
      // While the client is learned, "api" is read slowly, so the search for
      // an owner ends before the scan that would let go of the socket.
      let slow = true;
      const fs: ProcFs = {
        ...reads.fs,
        link: async (path) => {
          if (slow && path.includes("/100/fd/")) {
            await Bun.sleep(30);
          }
          return reads.fs.link(path);
        },
      };
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: fs, now: () => now, openKernel: async () => kernel.kernel, self: 50 });
      const apiOnly = () => [{ name: "api", pid: 100 }];
      for (let index = 0; index < 3; index += 1) {
        expect(await callerServiceForPeer(connect(400, 2), apiOnly, resolver)).toBeUndefined();
      }
      slow = false;
      // The client is now a hot owner: its next connection costs one read.
      reads.linked.length = 0;
      expect(await callerServiceForPeer(connect(400, 2), apiOnly, resolver)).toBeUndefined();
      expect(reads.linked).toEqual([`${proc.root}/400/fd/2`]);
      // No search beside the scan: nothing missed in the last five seconds.
      now = 6_000;
      reads.linked.length = 0;
      expect(await callerServiceForPeer(connect(100, 20), apiOnly, resolver)).toBe("api");
      expect(onlyFrom(reads.linked, 400)).toEqual([`${proc.root}/400/fd/2`]);
    } finally {
      proc.close();
    }
  });

  test("a client holding many connections at once is read before a service holding thousands, which is not even listed", async () => {
    const { proc, open, connect } = churnWorld();
    try {
      // 150 open at a time, each new one at whichever descriptor was freed.
      proc.grow(400, 11, 140);
      const reads = counting(nodeProcFs(proc.root));
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => kernel.kernel, self: 50 });
      expect(await callerServiceForPeer(connect(400, 20), churnServices, resolver)).toBeUndefined();
      expect(await callerServiceForPeer(connect(400, 21), churnServices, resolver)).toBeUndefined();
      reads.linked.length = 0;
      reads.listed.length = 0;
      for (let index = 0; index < 10; index += 1) {
        expect(await callerServiceForPeer(connect(400, 30 + index * 7), churnServices, resolver)).toBeUndefined();
      }
      expect(onlyFrom(reads.linked, 200)).toEqual([]);
      expect(reads.listed).not.toContain(`${proc.root}/200/fd`);
      expect(onlyFrom(reads.linked, 400).length).toBeGreaterThan(10);
    } finally {
      proc.close();
    }
  });

  test("a process that has grown since it was last listed goes back in line behind smaller ones", async () => {
    const proc = fakeProc();
    try {
      proc.add({ pid: 100, ppid: 1, files: 4 });
      proc.add({ pid: 200, ppid: 1, files: 1 });
      const open = new Map<string, SocketAnswer>([[`${0xd801}>${PROXY_PORT}`, { inode: "81001" }], [`${0xd802}>${PROXY_PORT}`, { inode: "81002" }]]);
      proc.hold(100, 4, "81001");
      const reads = counting(nodeProcFs(proc.root));
      const kernel = fakeKernel(open);
      const both = () => [{ name: "api", pid: 100 }, { name: "hog", pid: 200 }];
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => 0, openKernel: async () => kernel.kernel, self: 50 });
      // Listed with 1 descriptor and read first.
      expect(await callerServiceForPeer(viaProxy(0xd801), both, resolver)).toBe("api");
      // It now holds 3,001, and "api" a new connection.
      proc.grow(200, 1, 3_000);
      proc.hold(100, 5, "81002");
      reads.linked.length = 0;
      expect(await callerServiceForPeer(viaProxy(0xd802), both, resolver)).toBe("api");
      expect(onlyFrom(reads.linked, 200)).toEqual([]);
    } finally {
      proc.close();
    }
  });

  test("a hot owner that holds none of the looked-up sockets for ten seconds is no longer read", async () => {
    const { proc, open, connect } = churnWorld();
    try {
      let now = 0;
      const reads = counting(nodeProcFs(proc.root));
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => now, openKernel: async () => kernel.kernel, self: 50 });
      for (let index = 0; index < 3; index += 1) {
        expect(await callerServiceForPeer(connect(), churnServices, resolver)).toBeUndefined();
      }
      now = 10_001;
      reads.linked.length = 0;
      expect(await callerServiceForPeer(connect(100, 4), churnServices, resolver)).toBe("api");
      expect(onlyFrom(reads.linked, 400)).toEqual([]);
    } finally {
      proc.close();
    }
  });

  test("a search that finds no owner waits before the next, longer each time", async () => {
    const { proc, open, connect } = churnWorld();
    try {
      let now = 0;
      const reads = counting(nodeProcFs(proc.root));
      const kernel = fakeKernel(open);
      const resolver = new PeerCallerResolver({ proc: reads.fs, now: () => now, openKernel: async () => kernel.kernel, self: 50 });
      // Connections whose socket no readable process holds: the client closed it at once.
      const vanished = (): ReturnType<typeof viaProxy> => {
        const peer = connect();
        proc.hold(400, 10, undefined);
        return peer;
      };
      const searches = (): number => reads.listed.filter((path) => path.endsWith("/300/fd")).length;
      expect(await callerServiceForPeer(vanished(), churnServices, resolver)).toBeUndefined();
      expect(searches()).toBe(0);
      for (let index = 0; index < 5; index += 1) {
        expect(await callerServiceForPeer(vanished(), churnServices, resolver)).toBeUndefined();
        await Bun.sleep(5);
      }
      // One search at time 0, then none until 100 ms later.
      expect(searches()).toBe(1);
      now = 100;
      expect(await callerServiceForPeer(vanished(), churnServices, resolver)).toBeUndefined();
      await Bun.sleep(5);
      now = 150;
      expect(await callerServiceForPeer(vanished(), churnServices, resolver)).toBeUndefined();
      await Bun.sleep(5);
      // The second waited 100 ms; the third must wait 200.
      expect(searches()).toBe(2);
    } finally {
      proc.close();
    }
  });

  test("uses lsof-style lookups only when the tcp table cannot be read", async () => {
    const proc = fakeProc();
    try {
      let asked = 0;
      const lookups: PeerCallerLookups = {
        ownerPidForPort: async () => {
          asked += 1;
          return 100;
        },
        ancestorPids: async (pid) => [pid],
        processGroupId: async () => undefined,
      };
      const readable = new PeerCallerResolver({ proc: nodeProcFs(proc.root), lookups, now: () => 0 });
      expect(await callerServiceForPeer(peer, services, readable)).toBeUndefined();
      expect(asked).toBe(0);
      const hidden = new PeerCallerResolver({ proc: nodeProcFs(join(proc.root, "missing")), lookups, now: () => 0 });
      expect(await callerServiceForPeer(peer, services, hidden)).toBe("api");
      expect(asked).toBe(1);
    } finally {
      proc.close();
    }
  });
});

describe("managedCallers", () => {
  test("maps descendants within the ancestor walk and members of a managed process group", () => {
    const table = new Map([
      [100, { ppid: 1, pgid: 100 }],
      [101, { ppid: 100, pgid: 100 }],
      [102, { ppid: 101, pgid: 102 }],
      [200, { ppid: 1, pgid: 100 }],
      [300, { ppid: 1, pgid: 300 }],
    ]);
    const index = managedCallers(table, [{ name: "api", pid: 100 }, { name: "gone", pid: 400 }]);
    expect([...index.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [100, "api"],
      [101, "api"],
      [102, "api"],
      [200, "api"],
      [400, "gone"],
    ]);
  });
});
