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

function isIpv4MappedLoopback(host: string): boolean {
  const prefix = "::ffff:";
  if (!host.startsWith(prefix)) {
    return false;
  }
  return isIpv4Loopback(host.slice(prefix.length));
}
