import { describe, expect, test } from "bun:test";
import {
  callerServiceForPeer,
  parseLsofLocalTcpOwner,
  parseNetstatLocalTcpOwner,
  parseProcNetTcpInode,
  parseProcPidStat,
  parsePsPidColumn,
  type PeerCallerLookups,
} from "./peer-caller.ts";

const lookups = (owner: number | undefined, ancestors: number[], pgid?: number): PeerCallerLookups => ({
  ownerPidForPort: async () => owner,
  ancestorPids: async () => ancestors,
  processGroupId: async () => pgid,
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
