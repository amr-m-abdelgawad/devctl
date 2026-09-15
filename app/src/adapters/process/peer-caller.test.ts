import { describe, expect, test } from "bun:test";
import {
  callerServiceForPeer,
  parseLsofLocalTcpOwner,
  parseNetstatLocalTcpOwner,
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
