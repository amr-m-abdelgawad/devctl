import { LOCALHOST } from "../config/types.ts";

export type ListenBind = {
  host?: string;
  port?: number;
};

/** Empty/whitespace host is the loopback default used by every listener. */
export function normalizeListenHost(host?: string): string {
  const trimmed = (host ?? "").trim();
  if (trimmed === "") {
    return LOCALHOST;
  }
  return canonicalizeIpLiteral(trimmed);
}

/** Stable `host:port` key for comparing listener binds. */
export function listenKey(listen?: ListenBind): string {
  return `${normalizeListenHost(listen?.host)}:${listen?.port ?? 0}`;
}

function canonicalizeIpLiteral(host: string): string {
  const raw = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const expanded = expandIpv6(raw);
  return expanded ?? raw;
}

function expandIpv6(host: string): string | undefined {
  const value = host.trim().toLowerCase();
  if (!value.includes(":")) {
    return undefined;
  }
  const [head, tail] = value.split("::");
  const headParts = head === "" || head === undefined ? [] : head.split(":");
  const tailParts = tail === undefined ? undefined : tail === "" ? [] : tail.split(":");
  const missing = tailParts === undefined ? 0 : 8 - headParts.length - tailParts.length;
  const parts = tailParts === undefined
    ? headParts
    : [...headParts, ...Array.from({ length: Math.max(missing, 0) }, () => "0"), ...tailParts];
  if (missing < 0 || parts.length !== 8 || parts.some((part) => part === "" || !/^[0-9a-f]{1,4}$/.test(part))) {
    return undefined;
  }
  return parts.map((part) => part.padStart(4, "0")).join(":");
}

export function sameListen(a?: ListenBind, b?: ListenBind): boolean {
  return listenKey(a) === listenKey(b);
}
