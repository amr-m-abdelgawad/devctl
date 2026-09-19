import { LOCALHOST } from "../config/types.ts";

export type ListenBind = {
  host?: string;
  port?: number;
};

/** Empty/whitespace host is the loopback default used by every listener. */
export function normalizeListenHost(host?: string): string {
  const trimmed = (host ?? "").trim();
  return trimmed === "" ? LOCALHOST : trimmed;
}

/** Stable `host:port` key for comparing listener binds. */
export function listenKey(listen?: ListenBind): string {
  return `${normalizeListenHost(listen?.host)}:${listen?.port ?? 0}`;
}

export function sameListen(a?: ListenBind, b?: ListenBind): boolean {
  return listenKey(a) === listenKey(b);
}
