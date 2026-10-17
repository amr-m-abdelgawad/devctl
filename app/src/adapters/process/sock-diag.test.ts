import { readFileSync } from "node:fs";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { describe, expect, test } from "bun:test";
import { parseProcNetTcpInode } from "./peer-caller.ts";
import { decodeSocketReply, encodeSocketRequest, openSocketDiag, socketDiag, type NetlinkChannel, type SocketDiag, type TcpEndpoint } from "./sock-diag.ts";

const client: TcpEndpoint = { address: "127.0.0.1", port: 0xd431 };
const proxy: TcpEndpoint = { address: "127.0.0.1", port: 0x43f8 };

// A reply the kernel could send: an inet_diag_msg for one socket, or an error.
function socketReply(seq: number, fields: { sport: number; dport: number; state: number; inode: number }): Uint8Array {
  const reply = new Uint8Array(120);
  const view = new DataView(reply.buffer);
  view.setUint32(0, reply.length, true);
  view.setUint16(4, 20, true);
  view.setUint32(8, seq, true);
  reply[16] = 2;
  reply[17] = fields.state;
  view.setUint16(20, fields.sport, false);
  view.setUint16(22, fields.dport, false);
  view.setUint32(84, fields.inode, true);
  return reply;
}

function errorReply(seq: number, errno: number): Uint8Array {
  const reply = new Uint8Array(36);
  const view = new DataView(reply.buffer);
  view.setUint32(0, reply.length, true);
  view.setUint16(4, 2, true);
  view.setUint32(8, seq, true);
  view.setInt32(16, -errno, true);
  return reply;
}

function decode(reply: Uint8Array, seq = 7): ReturnType<typeof decodeSocketReply> {
  return decodeSocketReply(reply, reply.length, seq, client, proxy);
}

describe("sock_diag request", () => {
  test("asks for exactly one socket by both ends, in network byte order", () => {
    const request = new Uint8Array(72);
    expect(encodeSocketRequest(request, 7, client, proxy)).toBe(true);
    const view = new DataView(request.buffer);
    expect(view.getUint32(0, true)).toBe(72);
    expect(view.getUint16(4, true)).toBe(20);
    // NLM_F_REQUEST alone: a dump (NLM_F_DUMP) would walk every socket.
    expect(view.getUint16(6, true)).toBe(1);
    expect(view.getUint32(8, true)).toBe(7);
    expect([request[16], request[17]]).toEqual([2, 6]);
    expect(view.getUint16(24, false)).toBe(0xd431);
    expect(view.getUint16(26, false)).toBe(0x43f8);
    expect([...request.subarray(28, 32)]).toEqual([127, 0, 0, 1]);
    expect([...request.subarray(44, 48)]).toEqual([127, 0, 0, 1]);
    // The loopback device, so a client socket bound to it is found too.
    expect(view.getUint32(60, true)).toBe(1);
    // No cookie: the kernel would refuse a request whose cookie does not match.
    expect([view.getUint32(64, true), view.getUint32(68, true)]).toEqual([0xffffffff, 0xffffffff]);
  });

  test("asks for a mapped IPv4 address as IPv4 and for ::1 as IPv6", () => {
    const request = new Uint8Array(72);
    expect(encodeSocketRequest(request, 1, { address: "::ffff:127.0.0.1", port: 9 }, { address: "::FFFF:127.0.0.2", port: 10 })).toBe(true);
    expect(request[16]).toBe(2);
    expect([...request.subarray(28, 32)]).toEqual([127, 0, 0, 1]);
    expect([...request.subarray(44, 48)]).toEqual([127, 0, 0, 2]);
    expect(encodeSocketRequest(request, 1, { address: "::1", port: 9 }, { address: "::1", port: 10 })).toBe(true);
    expect(request[16]).toBe(10);
    expect([...request.subarray(28, 44)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  test("refuses ends it cannot ask for together", () => {
    const request = new Uint8Array(72);
    expect(encodeSocketRequest(request, 1, { address: "127.0.0.1", port: 9 }, { address: "::1", port: 10 })).toBe(false);
    expect(encodeSocketRequest(request, 1, { address: "localhost", port: 9 }, proxy)).toBe(false);
    expect(encodeSocketRequest(request, 1, { address: "fe80::1", port: 9 }, { address: "fe80::2", port: 10 })).toBe(false);
    expect(encodeSocketRequest(request, 1, { address: "127.0.0.256", port: 9 }, proxy)).toBe(false);
    expect(encodeSocketRequest(request, 1, { address: "127.0.0.1", port: 0 }, proxy)).toBe(false);
    expect(encodeSocketRequest(request, 1, client, { address: "127.0.0.1", port: 70_000 })).toBe(false);
  });
});

describe("sock_diag reply", () => {
  test("an open socket with both ends as asked gives its inode", () => {
    expect(decode(socketReply(7, { sport: 0xd431, dport: 0x43f8, state: 1, inode: 4_000_000_123 }))).toEqual({ inode: "4000000123" });
  });

  test("TIME_WAIT, a socket no process holds, and a listener standing in for the connection are closed", () => {
    expect(decode(socketReply(7, { sport: 0xd431, dport: 0x43f8, state: 6, inode: 0 }))).toBe("closed");
    expect(decode(socketReply(7, { sport: 0xd431, dport: 0x43f8, state: 4, inode: 0 }))).toBe("closed");
    // With no such connection the kernel answers with what listens on the local port.
    expect(decode(socketReply(7, { sport: 0xd431, dport: 0, state: 10, inode: 99 }))).toBe("closed");
  });

  test("no such socket is missing; any other error, a short reply, or another request's reply is not an answer", () => {
    expect(decode(errorReply(7, 2))).toBe("missing");
    expect(decode(errorReply(7, 22))).toBe("unknown");
    expect(decode(new Uint8Array(12))).toBe("unknown");
    expect(decode(socketReply(7, { sport: 0xd431, dport: 0x43f8, state: 1, inode: 5 }).subarray(0, 60))).toBe("unknown");
    expect(decode(socketReply(6, { sport: 0xd431, dport: 0x43f8, state: 1, inode: 5 }))).toBe("stale");
  });
});

// A kernel that answers each request at once, after any replies left queued.
function fakeChannel(answer: (seq: number) => Uint8Array | undefined, queued: Uint8Array[] = []) {
  const counts = { sent: 0, received: 0 };
  let lastSeq = 0;
  const channel: NetlinkChannel = {
    send: (request) => {
      counts.sent += 1;
      lastSeq = new DataView(request.buffer).getUint32(8, true);
      const reply = answer(lastSeq);
      if (reply === undefined) {
        return false;
      }
      queued.push(reply);
      return true;
    },
    receive: (into) => {
      counts.received += 1;
      const reply = queued.shift();
      if (reply === undefined) {
        return -1;
      }
      into.set(reply.subarray(0, into.length));
      return Math.min(reply.length, into.length);
    },
  };
  return { channel, counts };
}

describe("socketDiag", () => {
  test("one request and one read per lookup", () => {
    const fake = fakeChannel((seq) => socketReply(seq, { sport: 0xd431, dport: 0x43f8, state: 1, inode: 77 }));
    const diag = socketDiag(fake.channel);
    expect(diag.socket(client, proxy)).toEqual({ inode: "77" });
    expect(diag.socket(client, proxy)).toEqual({ inode: "77" });
    expect(fake.counts).toEqual({ sent: 2, received: 2 });
  });

  test("a reply left over from an earlier request is passed over", () => {
    const left = [socketReply(1_000, { sport: 0xd431, dport: 0x43f8, state: 1, inode: 1 })];
    const fake = fakeChannel((seq) => socketReply(seq, { sport: 0xd431, dport: 0x43f8, state: 1, inode: 2 }), left);
    expect(socketDiag(fake.channel).socket(client, proxy)).toEqual({ inode: "2" });
  });

  test("a request the kernel did not take, or no reply, is unknown", () => {
    expect(socketDiag(fakeChannel(() => undefined).channel).socket(client, proxy)).toBe("unknown");
    const silent = fakeChannel(() => new Uint8Array(0));
    // The empty reply is read as a short one; nothing is left waiting after it.
    expect(socketDiag(silent.channel).socket(client, proxy)).toBe("unknown");
    // Ends that cannot be put in a request are not sent at all.
    const unsent = fakeChannel(() => socketReply(1, { sport: 1, dport: 1, state: 1, inode: 1 }));
    expect(socketDiag(unsent.channel).socket({ address: "localhost", port: 1 }, proxy)).toBe("unasked");
    expect(unsent.counts.sent).toBe(0);
  });
});

function listen(host: string): Promise<{ server: Server; port: number; accepted: Socket[] }> {
  return new Promise((resolve, reject) => {
    const accepted: Socket[] = [];
    const server = createServer((socket) => {
      accepted.push(socket);
      socket.on("error", () => undefined);
    });
    server.once("error", reject);
    server.listen(0, host, () => resolve({ server, port: (server.address() as AddressInfo).port, accepted }));
  });
}

function dial(host: string, port: number, allowHalfOpen = false): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, allowHalfOpen }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
    socket.destroy();
  });
}

async function accepted(list: Socket[], count: number): Promise<Socket> {
  for (let tries = 0; list.length < count && tries < 200; tries += 1) {
    await Bun.sleep(5);
  }
  return list[count - 1]!;
}

function tableInode(file: "tcp" | "tcp6", port: number, remotePort: number): string | undefined {
  return parseProcNetTcpInode(readFileSync(`/proc/net/${file}`, "utf8"), port, remotePort);
}

describe.skipIf(process.platform !== "linux")("the kernel's socket lookup", () => {
  let diag: SocketDiag;

  test("opens", async () => {
    const opened = await openSocketDiag();
    expect(opened).toBeDefined();
    diag = opened!;
  });

  test("gives the inode /proc/net/tcp gives, for the client's end and for the server's", async () => {
    const v4 = await listen("127.0.0.1");
    try {
      const socket = await dial("127.0.0.1", v4.port);
      const server = await accepted(v4.accepted, 1);
      const clientEnd = { address: "127.0.0.1", port: socket.localPort! };
      const serverEnd = { address: "127.0.0.1", port: v4.port };
      expect(diag.socket(clientEnd, serverEnd)).toEqual({ inode: tableInode("tcp", clientEnd.port, serverEnd.port)! });
      expect(diag.socket(serverEnd, clientEnd)).toEqual({ inode: tableInode("tcp", serverEnd.port, clientEnd.port)! });
      // The two ends are two sockets.
      expect(diag.socket(clientEnd, serverEnd)).not.toEqual(diag.socket(serverEnd, clientEnd));
      await closed(socket);
      await closed(server);
    } finally {
      v4.server.close();
    }
  });

  test("finds IPv6 loopback sockets, and IPv4 ones a dual-stack listener reports as mapped", async () => {
    const v6 = await listen("::1");
    try {
      const socket = await dial("::1", v6.port);
      await accepted(v6.accepted, 1);
      expect(diag.socket({ address: "::1", port: socket.localPort! }, { address: "::1", port: v6.port })).toEqual({ inode: tableInode("tcp6", socket.localPort!, v6.port)! });
      socket.destroy();
    } finally {
      v6.server.close();
    }
    const dual = await listen("::");
    try {
      const socket = await dial("127.0.0.1", dual.port);
      const server = await accepted(dual.accepted, 1);
      // What the proxy sees on such a connection.
      expect(server.remoteAddress).toBe("::ffff:127.0.0.1");
      const seen = { client: { address: server.remoteAddress!, port: server.remotePort! }, proxy: { address: server.localAddress!, port: server.localPort! } };
      expect(diag.socket(seen.client, seen.proxy)).toEqual({ inode: tableInode("tcp", socket.localPort!, dual.port)! });
      // The listener is IPv6, so its accepted socket is in tcp6.
      expect(diag.socket(seen.proxy, seen.client)).toEqual({ inode: tableInode("tcp6", dual.port, socket.localPort!)! });
      socket.destroy();
    } finally {
      dual.server.close();
    }
  });

  test("a client that closed first is closed (TIME_WAIT); after the server closed first it is missing", async () => {
    const v4 = await listen("127.0.0.1");
    try {
      const first = await dial("127.0.0.1", v4.port);
      const firstServer = await accepted(v4.accepted, 1);
      const firstEnd = { address: "127.0.0.1", port: first.localPort! };
      const serverEnd = { address: "127.0.0.1", port: v4.port };
      await closed(first);
      await Bun.sleep(20);
      expect(diag.socket(firstEnd, serverEnd)).toBe("closed");
      await closed(firstServer);

      const second = await dial("127.0.0.1", v4.port, true);
      const secondServer = await accepted(v4.accepted, 2);
      const secondEnd = { address: "127.0.0.1", port: second.localPort! };
      await closed(secondServer);
      await Bun.sleep(20);
      // Still open on the client's side (CLOSE_WAIT) until it closes too.
      expect(typeof diag.socket(secondEnd, serverEnd)).toBe("object");
      await closed(second);
      await Bun.sleep(20);
      expect(diag.socket(secondEnd, serverEnd)).toBe("missing");
      // The server's end of that connection is gone; the listener answers for its port.
      expect(diag.socket(serverEnd, secondEnd)).toBe("closed");
    } finally {
      v4.server.close();
    }
  });

  test("costs the same however many sockets the table holds", async () => {
    const v4 = await listen("127.0.0.1");
    try {
      const socket = await dial("127.0.0.1", v4.port);
      await accepted(v4.accepted, 1);
      const ends = [{ address: "127.0.0.1", port: socket.localPort! }, { address: "127.0.0.1", port: v4.port }] as const;
      const perCall = (): number => {
        const calls = 20_000;
        const started = performance.now();
        for (let index = 0; index < calls; index += 1) {
          diag.socket(ends[0], ends[1]);
        }
        return (performance.now() - started) / calls;
      };
      const small = perCall();
      // Each closed connection leaves a TIME_WAIT row for a minute.
      for (let round = 0; round < 15; round += 1) {
        const batch = await Promise.all(Array.from({ length: 200 }, () => dial("127.0.0.1", v4.port)));
        await Promise.all(batch.map((one) => closed(one)));
      }
      const rows = readFileSync("/proc/net/tcp", "utf8").split("\n").length;
      expect(rows).toBeGreaterThan(2_500);
      const large = perCall();
      // Measured at about 0.7 µs either way; reading the table at this size takes milliseconds.
      expect(large).toBeLessThan(Math.max(small * 4, 0.05));
      socket.destroy();
    } finally {
      v4.server.close();
    }
  }, 60_000);
});
