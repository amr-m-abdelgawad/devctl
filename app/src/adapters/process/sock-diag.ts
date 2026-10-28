const AF_INET = 2;
const AF_INET6 = 10;
const AF_NETLINK = 16;
const SOCK_DGRAM = 2;
// The values on x86-64 and arm64, the Linux targets devctl ships; some other
// architectures (MIPS, SPARC, Alpha) number these two differently.
const SOCK_NONBLOCK = 0o4000;
const SOCK_CLOEXEC = 0o2000000;
const NETLINK_SOCK_DIAG = 4;
const SOCK_DIAG_BY_FAMILY = 20;
const NLM_F_REQUEST = 1;
const NLMSG_ERROR = 2;
const IPPROTO_TCP = 6;
const MSG_DONTWAIT = 0x40;
const ENOENT = 2;
const TCP_TIME_WAIT = 6;
// The loopback device has this index in every network namespace.
const LOOPBACK_IFINDEX = 1;
const NO_COOKIE = 0xffffffff;
// nlmsghdr (16) and inet_diag_req_v2 (56).
const REQUEST_BYTES = 72;
// nlmsghdr (16) and inet_diag_msg (72); the attributes after them are not read.
const REPLY_BYTES = 88;
const REPLY_BUFFER_BYTES = 512;
// A reply to an earlier request can be waiting only if that request's read failed.
const STALE_REPLIES_MAX = 4;

export type TcpEndpoint = {
  readonly address: string;
  readonly port: number;
};

/**
 * What the kernel says about the one TCP socket with these two ends:
 * - `inode`: it is open, and this is the inode `/proc/<pid>/fd` shows for it.
 * - `closed`: the kernel knows the connection and no process holds a socket
 *   for it (TIME_WAIT, or closed and still draining).
 * - `missing`: the kernel has no such socket. A kernel built without the
 *   lookup answers the same, so on its own this proves nothing.
 * - `unknown`: the kernel could not be asked.
 * - `unasked`: these two ends cannot be asked about together (an address
 *   this does not read, or one end IPv4 and the other IPv6).
 */
export type SocketAnswer = { readonly inode: string } | "closed" | "missing" | "unknown" | "unasked";

/** Asks the kernel for one TCP socket by its local and remote end. */
export type SocketDiag = {
  readonly socket: (local: TcpEndpoint, remote: TcpEndpoint) => SocketAnswer;
};

/** A netlink socket: one datagram out, one datagram in, neither of which waits. */
export type NetlinkChannel = {
  /** True when the whole request was handed to the kernel. */
  readonly send: (request: Uint8Array) => boolean;
  /** Bytes copied into `reply`, or a value below zero when nothing was waiting. */
  readonly receive: (reply: Uint8Array) => number;
};

type Address = { readonly family: number; readonly bytes: readonly number[] };

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

// The forms a loopback connection's ends take: dotted IPv4, IPv4 mapped into
// IPv6 (what a dual-stack listener reports for an IPv4 peer), and `::1`. A
// mapped address is asked for as IPv4, which is how the kernel files it.
function parseAddress(address: string): Address | undefined {
  const text = address.trim().toLowerCase();
  const octets = ipv4Octets(text.startsWith("::ffff:") ? text.slice("::ffff:".length) : text);
  if (octets !== undefined) {
    return { family: AF_INET, bytes: octets };
  }
  if (text === "::1") {
    return { family: AF_INET6, bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] };
  }
  return undefined;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 0xffff;
}

/**
 * Writes an exact-match `inet_diag_req_v2` for the socket whose local end is
 * `local` and whose remote end is `remote`. False when the two ends cannot be
 * asked for together (an address this does not read, or mixed families).
 */
export function encodeSocketRequest(request: Uint8Array, seq: number, local: TcpEndpoint, remote: TcpEndpoint): boolean {
  const src = parseAddress(local.address);
  const dst = parseAddress(remote.address);
  if (src === undefined || dst === undefined || src.family !== dst.family || !validPort(local.port) || !validPort(remote.port)) {
    return false;
  }
  const view = new DataView(request.buffer, request.byteOffset, REQUEST_BYTES);
  request.fill(0, 0, REQUEST_BYTES);
  view.setUint32(0, REQUEST_BYTES, true);
  view.setUint16(4, SOCK_DIAG_BY_FAMILY, true);
  // No NLM_F_DUMP: a dump walks every socket, which is the cost this replaces.
  view.setUint16(6, NLM_F_REQUEST, true);
  view.setUint32(8, seq, true);
  request[16] = src.family;
  request[17] = IPPROTO_TCP;
  // Ports and addresses are in network byte order.
  view.setUint16(24, local.port, false);
  view.setUint16(26, remote.port, false);
  request.set(src.bytes, 28);
  request.set(dst.bytes, 44);
  // A socket bound to a device is found only when the request names that
  // device. Naming loopback finds those and every unbound socket as well.
  view.setUint32(60, LOOPBACK_IFINDEX, true);
  view.setUint32(64, NO_COOKIE, true);
  view.setUint32(68, NO_COOKIE, true);
  return true;
}

/** Reads the reply to request `seq`, or `stale` when it answers an earlier request. */
export function decodeSocketReply(reply: Uint8Array, length: number, seq: number, local: TcpEndpoint, remote: TcpEndpoint): SocketAnswer | "stale" {
  if (length < 20) {
    return "unknown";
  }
  const view = new DataView(reply.buffer, reply.byteOffset, length);
  if (view.getUint32(8, true) !== seq) {
    return "stale";
  }
  const type = view.getUint16(4, true);
  if (type === NLMSG_ERROR) {
    return view.getInt32(16, true) === -ENOENT ? "missing" : "unknown";
  }
  if (type !== SOCK_DIAG_BY_FAMILY || length < REPLY_BYTES) {
    return "unknown";
  }
  // With no connection between these two ends the kernel answers with a
  // socket listening on the local port, if there is one. That reply carries
  // no remote port, so it is told apart here.
  if (view.getUint16(20, false) !== local.port || view.getUint16(22, false) !== remote.port) {
    return "closed";
  }
  const inode = view.getUint32(84, true);
  if (reply[17] === TCP_TIME_WAIT || inode === 0) {
    return "closed";
  }
  return { inode: String(inode) };
}

/** The lookup over an open netlink socket. */
export function socketDiag(channel: NetlinkChannel): SocketDiag {
  const request = new Uint8Array(REQUEST_BYTES);
  const reply = new Uint8Array(REPLY_BUFFER_BYTES);
  let seq = 0;
  return {
    socket(local, remote) {
      seq = seq >= 0xffffffff ? 1 : seq + 1;
      if (!encodeSocketRequest(request, seq, local, remote)) {
        return "unasked";
      }
      if (!channel.send(request)) {
        return "unknown";
      }
      // The kernel answers an exact-match request before `send` returns, so
      // the reply is already waiting and this read does not block.
      for (let read = 0; read <= STALE_REPLIES_MAX; read += 1) {
        const answer = decodeSocketReply(reply, channel.receive(reply), seq, local, remote);
        if (answer !== "stale") {
          return answer;
        }
      }
      return "unknown";
    },
  };
}

/**
 * Opens the kernel's socket lookup (NETLINK_SOCK_DIAG) for this process's
 * network namespace. Undefined where it cannot be opened: not Linux, no glibc
 * to call into (musl), or a sandbox that refuses the socket. The socket stays
 * open for the life of the process and is not inherited by children.
 */
export async function openSocketDiag(): Promise<SocketDiag | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
      recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    }).symbols;
    const fd = libc.socket(AF_NETLINK, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
    if (fd < 0) {
      return undefined;
    }
    // A call that throws is a request the kernel did not take, not a lookup that fails.
    return socketDiag({
      send: (request) => {
        try {
          return Number(libc.send(fd, request, request.length, MSG_DONTWAIT)) === request.length;
        } catch {
          return false;
        }
      },
      receive: (reply) => {
        try {
          return Number(libc.recv(fd, reply, reply.length, MSG_DONTWAIT));
        } catch {
          return -1;
        }
      },
    });
  } catch {
    return undefined;
  }
}
