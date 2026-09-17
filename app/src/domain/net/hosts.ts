/** Addresses a local listener may bind without exposing developer credentials. */
export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "") {
    return true;
  }
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (isIpv4Loopback(normalized)) {
    return true;
  }
  return isIpv4MappedLoopback(normalized);
}

/**
 * Hostnames that are loopback for HTTP Host / Origin checks.
 * Empty is not loopback. Brackets, trailing dots, zone ids, and expanded ::1 are accepted.
 */
export function isLoopbackHostname(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "") {
    return false;
  }
  if (isLoopbackBindHost(normalized)) {
    return true;
  }
  return isExpandedIpv6Loopback(normalized);
}

/** Hostname from an HTTP Host header (`127.0.0.1:18900`, `[::1]`, `localhost`). */
export function hostnameFromHostHeader(header: string): string | undefined {
  const value = header.trim().toLowerCase();
  if (value === "") {
    return undefined;
  }
  if (value.startsWith("[")) {
    return hostnameFromBracketedHost(value);
  }
  const ipv6 = hostnameFromUnbracketedIpv6(value);
  if (ipv6 !== undefined) {
    return ipv6;
  }
  const colon = value.lastIndexOf(":");
  if (colon === -1) {
    return value;
  }
  return value.slice(0, colon);
}

export function formatHostPort(host: string, port: number): string {
  const trimmed = host.trim();
  const name = trimmed === "" ? "127.0.0.1" : trimmed;
  if (name.includes(":") && !name.startsWith("[")) {
    return `[${name}]:${port}`;
  }
  return `${name}:${port}`;
}

const METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata"]);
// Metadata endpoints that are not in the 169.254/16 link-local range and so
// need naming explicitly. Alibaba Cloud uses 100.100.100.200.
const METADATA_IPV4 = new Set(["100.100.100.200"]);

/**
 * Hosts an outbound recipe must not target without an explicit opt-in: IPv4
 * link-local `169.254.0.0/16` (which includes the `169.254.169.254` cloud
 * metadata endpoint), its IPv4-mapped forms (dotted and the hex form the URL
 * parser canonicalizes brackets to, e.g. `::ffff:a9fe:a9fe`), IPv6 link-local
 * `fe80::/10`, the GCE metadata hostnames, and known non-link-local metadata
 * IPs. Blocks SSRF of minted developer tokens to the instance metadata service.
 * Empty/unknown is not blocked (handled elsewhere).
 */
export function isLinkLocalOrMetadataHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "") {
    return false;
  }
  if (METADATA_HOSTNAMES.has(normalized)) {
    return true;
  }
  const octets = extractIpv4(normalized);
  if (octets !== undefined) {
    if (octets[0] === 169 && octets[1] === 254) {
      return true;
    }
    if (METADATA_IPV4.has(octets.join("."))) {
      return true;
    }
  }
  return isIpv6LinkLocal(normalized);
}

/** Peer address on an accepted connection. Missing/empty is not loopback. */
export function isLoopbackPeer(addr?: string): boolean {
  if (addr === undefined) {
    return false;
  }
  const normalized = addr.trim().toLowerCase();
  if (normalized === "") {
    return false;
  }
  return isLoopbackBindHost(normalized);
}

function hostnameFromBracketedHost(value: string): string | undefined {
  const close = value.indexOf("]");
  if (close < 2) {
    return undefined;
  }
  const rest = value.slice(close + 1);
  if (rest !== "" && !rest.startsWith(":")) {
    return undefined;
  }
  return value.slice(1, close);
}

function hostnameFromUnbracketedIpv6(value: string): string | undefined {
  if (colonCount(value) < 2) {
    return undefined;
  }
  const loopback = hostnameFromUnbracketedLoopbackPort(value);
  return loopback ?? value;
}

function hostnameFromUnbracketedLoopbackPort(value: string): string | undefined {
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(value);
  if (v4Mapped?.[1] !== undefined) {
    return `::ffff:${v4Mapped[1]}`;
  }
  if (/^::1:\d+$/.test(value)) {
    return "::1";
  }
  return undefined;
}

function normalizeHostname(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  return stripTrailingDots(stripZoneId(value));
}

/** Linear strip; `/\.+$/` is a polynomial-ReDoS finding on Host input. */
function stripTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ".") {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function stripZoneId(host: string): string {
  const index = host.indexOf("%");
  if (index === -1) {
    return host;
  }
  return host.slice(0, index);
}

function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  return octets[0] === 127;
}

// Extract IPv4 octets from a normalized hostname in any of the forms an IPv4
// address can reach us as: dotted (`169.254.169.254`), IPv4-mapped dotted
// (`::ffff:169.254.169.254`), or the IPv4-mapped hex pair the WHATWG URL parser
// canonicalizes a bracketed mapped address to (`::ffff:a9fe:a9fe`). Returns
// undefined for anything that is not an IPv4 address.
function extractIpv4(host: string): number[] | undefined {
  const candidate = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(candidate);
  if (hex) {
    const hi = Number.parseInt(hex[1] ?? "", 16);
    const lo = Number.parseInt(hex[2] ?? "", 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  const parts = candidate.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return undefined;
  }
  return octets;
}

function isIpv6LinkLocal(host: string): boolean {
  const first = host.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/.test(first)) {
    return false;
  }
  const n = Number.parseInt(first, 16);
  return n >= 0xfe80 && n <= 0xfebf;
}

function isIpv4MappedLoopback(host: string): boolean {
  const prefix = "::ffff:";
  if (!host.startsWith(prefix)) {
    return false;
  }
  return isIpv4Loopback(host.slice(prefix.length));
}

function isExpandedIpv6Loopback(host: string): boolean {
  const groups = host.split(":");
  if (groups.length !== 8) {
    return false;
  }
  return groups.every((group, index) => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return false;
    }
    const n = Number.parseInt(group, 16);
    return index === 7 ? n === 1 : n === 0;
  });
}

function colonCount(value: string): number {
  return value.split(":").length - 1;
}
