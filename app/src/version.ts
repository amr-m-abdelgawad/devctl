export const VERSION = process.env.DEVCTL_VERSION ?? "0.2.3";

export function versionLine(): string {
  return `devctl ${VERSION}`;
}

// Bumped only when the local supervisor RPC wire format changes in a way a
// client must not silently ignore (new required fields, changed method
// semantics). Independent of VERSION: two binaries can differ in VERSION
// while speaking the same RPC_PROTOCOL_VERSION, and the client/daemon
// handshake treats that as compatible.
export const RPC_PROTOCOL_VERSION = 1;
