import * as http2 from "node:http2";
import type { ClientHttp2Session } from "node:http2";

// A laptop sleep or a dropped network leaves the upstream TCP socket ESTABLISHED
// and the runtime never emits error, close, or GOAWAY, so every later RPC would
// be written onto a session that cannot answer. These bounds are the recovery:
// PINGs notice silence, and a handshake that never finishes fails the RPC.
export const UPSTREAM_PING_INTERVAL_MS = 30_000;
export const UPSTREAM_PING_TIMEOUT_MS = 15_000;
export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
// grpc-go's default keepalive MinTime. Past this, more frequent PINGs are what
// got the connection GOAWAY'd; staying here avoids a reconnect loop.
export const UPSTREAM_PING_INTERVAL_MAX_MS = 5 * 60_000;

const ERROR_CHAIN_LIMIT = 8;

const NETWORK_FAILURE = /EAI_AGAIN|EAI_FAIL|EAI_NONAME|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EHOSTDOWN|EPIPE|ECONNABORTED|EADDRNOTAVAIL|EPROTO|getaddrinfo|socket hang up|upstream connect timeout|upstream ping timeout|upstream connection|ERR_HTTP2_SESSION_ERROR|ERR_SSL_/;

export type UpstreamTiming = {
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
};

export function nextPingIntervalMs(currentMs: number, maxMs = UPSTREAM_PING_INTERVAL_MAX_MS): number {
  if (!Number.isFinite(currentMs) || currentMs <= 0) return maxMs;
  const doubled = currentMs * 2;
  return doubled > maxMs ? maxMs : doubled;
}

export function isPingPenaltyGoaway(opaque: unknown): boolean {
  return goawayText(opaque).includes("too_many_pings");
}

// Walk cause / causeError so a wrapped "Google authentication failed: getaddrinfo
// EAI_AGAIN …" still counts. Stream cancel and an idle long-poll do not.
export function isUpstreamNetworkFailure(err: unknown): boolean {
  return NETWORK_FAILURE.test(errorChainText(err));
}

function errorChainText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current) && parts.length < ERROR_CHAIN_LIMIT) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const record = current as { message?: unknown; code?: unknown; cause?: unknown; causeError?: unknown };
    if (typeof record.code === "string" && record.code !== "") parts.push(record.code);
    if (typeof record.message === "string" && record.message !== "") parts.push(record.message);
    const next = record.causeError ?? record.cause;
    current = next === current ? undefined : next;
  }
  return parts.join(" ");
}

type DropLog = (message: string) => void;

// One live HTTP/2 client per upstream URL. A session that has closed, errored,
// or failed a PING is removed and the next RPC dials again. A session marked
// suspect is PINGed before it is reused.
export class UpstreamPool {
  private readonly sessions = new Map<string, PooledSession>();
  private readonly opening = new Map<string, Promise<PooledSession>>();
  private readonly dialing = new Map<string, PooledSession>();
  private readonly live = new Set<PooledSession>();
  private readonly intervals = new Map<string, number>();
  private readonly pingIntervalMs: number;
  private readonly pingTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    timing: UpstreamTiming = {},
    private readonly onDrop?: DropLog,
  ) {
    this.pingIntervalMs = positiveMs(timing.pingIntervalMs, UPSTREAM_PING_INTERVAL_MS);
    this.pingTimeoutMs = positiveMs(timing.pingTimeoutMs, UPSTREAM_PING_TIMEOUT_MS);
    this.connectTimeoutMs = positiveMs(timing.connectTimeoutMs, UPSTREAM_CONNECT_TIMEOUT_MS);
    this.now = timing.now ?? Date.now;
  }

  // Resolves with a session that has finished the HTTP/2 handshake. When the
  // pooled session is suspect or has been silent for a full PING interval, this
  // waits for a PING first and dials a replacement if that PING is not answered.
  async acquire(url: string): Promise<ClientHttp2Session> {
    let pooled = await this.ready(url);
    if (pooled.needsProbe(this.now())) {
      const alive = await pooled.probe();
      if (!alive || !pooled.usable()) pooled = await this.ready(url);
    } else if (!pooled.usable()) {
      pooled = await this.ready(url);
    }
    if (!pooled.usable()) throw new Error("upstream unavailable");
    return pooled.session;
  }

  markSuspect(): void {
    for (const pooled of this.sessions.values()) pooled.markSuspect();
  }

  noteActivity(session: ClientHttp2Session): void {
    this.find(session)?.noteActivity();
  }

  dropSession(session: ClientHttp2Session, reason: string): void {
    this.find(session)?.drop(reason);
  }

  discard(url: string): void {
    this.sessions.get(url)?.shutdown();
    this.dialing.get(url)?.drop("upstream replaced", false);
  }

  discardAll(): void {
    for (const pooled of [...this.live]) pooled.drop("upstream closed", false);
    this.sessions.clear();
    this.live.clear();
  }

  private ready(url: string): Promise<PooledSession> {
    const existing = this.sessions.get(url);
    if (existing?.usable()) return Promise.resolve(existing);
    if (existing) existing.drop("upstream connection closed");
    const pending = this.opening.get(url);
    if (pending) return pending;
    const opening = this.open(url).finally(() => {
      if (this.opening.get(url) === opening) this.opening.delete(url);
    });
    this.opening.set(url, opening);
    return opening;
  }

  private open(url: string): Promise<PooledSession> {
    let session: ClientHttp2Session;
    try {
      session = http2.connect(url);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const pooled = new PooledSession(url, session, this.pingTimeoutMs, this.now, (message) => this.onDrop?.(message));
    this.live.add(pooled);
    this.dialing.set(url, pooled);
    pooled.bindUnpool(() => {
      this.live.delete(pooled);
      if (this.dialing.get(url) === pooled) this.dialing.delete(url);
      if (this.sessions.get(url) === pooled) this.sessions.delete(url);
    });
    return awaitConnected(pooled, this.connectTimeoutMs, () => {
      if (pooled.wasRemoved()) return;
      pooled.markReady(this.intervalFor(url));
      this.sessions.set(url, pooled);
    }, (opaque) => {
      if (!isPingPenaltyGoaway(opaque)) return;
      this.backoff(url);
    });
  }

  private find(session: ClientHttp2Session): PooledSession | undefined {
    for (const pooled of this.sessions.values()) {
      if (pooled.owns(session)) return pooled;
    }
    return undefined;
  }

  private intervalFor(url: string): number {
    return this.intervals.get(url) ?? this.pingIntervalMs;
  }

  private backoff(url: string): void {
    this.intervals.set(url, nextPingIntervalMs(this.intervalFor(url)));
  }
}

function positiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function goawayText(opaque: unknown): string {
  if (typeof opaque === "string") return opaque;
  if (Buffer.isBuffer(opaque)) return opaque.toString("utf8");
  if (ArrayBuffer.isView(opaque)) return Buffer.from(opaque.buffer, opaque.byteOffset, opaque.byteLength).toString("utf8");
  return "";
}

function awaitConnected(pooled: PooledSession, timeoutMs: number, onReady: () => void, onPenalty: (opaque: unknown) => void): Promise<PooledSession> {
  const session = pooled.session;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new Error("upstream connect timeout")), timeoutMs);
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pooled.drop(err.message, false);
      reject(err);
    };
    // Bun emits "connect" when TCP is up, before the peer has spoken HTTP/2.
    // A sink that accepts and never replies would otherwise look connected and
    // the RPC would sit there. Ready means the peer's SETTINGS arrived, or it
    // answered a PING; the timer bounds both.
    const ready = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        onReady();
      } catch (err) {
        pooled.drop("upstream connection error", false);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve(pooled);
    };
    session.on("error", (err: unknown) => {
      const error = err instanceof Error ? err : new Error("upstream connection error");
      if (!settled) {
        fail(error);
        return;
      }
      // Windows reports a single cancelled stream as ECONNRESET on the session.
      // The connection is still usable; tearing it down RSTs the peer.
      if (pooled.noteStreamReset(error)) return;
      pooled.drop(error.message || "upstream connection error");
    });
    session.on("close", () => {
      if (!settled) fail(new Error("upstream connection closed"));
      else pooled.retire("upstream connection closed");
    });
    session.on("goaway", (_code: number, _lastStreamID: number, opaque: unknown) => {
      onPenalty(opaque);
      const reason = isPingPenaltyGoaway(opaque) ? "upstream GOAWAY too_many_pings" : "upstream GOAWAY";
      if (!settled) fail(new Error(reason));
      else pooled.retire(reason);
    });
    session.on("remoteSettings", () => ready());
    session.on("connect", () => {
      try {
        session.ping((err) => {
          if (!err) ready();
        });
      } catch {
        // SETTINGS or the connect timeout still settle the dial.
      }
    });
  });
}

// `accepting` is false after GOAWAY, close, or a failed PING, including the
// window before Node flips `session.closed`. That session must not take a new RPC.
class PooledSession {
  readonly session: ClientHttp2Session;
  private readonly host: string;
  private readonly pingTimeoutMs: number;
  private readonly now: () => number;
  private readonly onDrop: DropLog;
  private unpool: () => void = () => {};
  private intervalMs = UPSTREAM_PING_INTERVAL_MS;
  private lastProofAt = 0;
  private suspect = false;
  private accepting = false;
  private removed = false;
  private connected = false;
  private socketWatched = false;
  private destroyed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private probePromise: Promise<boolean> | undefined;

  constructor(url: string, session: ClientHttp2Session, pingTimeoutMs: number, now: () => number, onDrop: DropLog) {
    this.session = session;
    this.host = hostOf(url);
    this.pingTimeoutMs = pingTimeoutMs;
    this.now = now;
    this.onDrop = onDrop;
  }

  bindUnpool(unpool: () => void): void {
    this.unpool = unpool;
  }

  owns(session: ClientHttp2Session): boolean {
    return this.session === session;
  }

  wasRemoved(): boolean {
    return this.removed;
  }

  markReady(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.connected = true;
    this.accepting = true;
    this.lastProofAt = this.now();
    this.watchSocket();
    this.schedule();
  }

  usable(): boolean {
    if (!this.accepting || this.removed || this.session.closed || this.session.destroyed) return false;
    return !this.socketDestroyed();
  }

  needsProbe(now: number): boolean {
    if (!this.usable()) return false;
    if (this.suspect) return true;
    return now - this.lastProofAt >= this.intervalMs;
  }

  markSuspect(): void {
    if (!this.removed) this.suspect = true;
  }

  // A reset of one stream, reported as ECONNRESET or EPIPE, is not proof the
  // connection died. Remember it and let the next RPC probe. A session that
  // has already closed still needs to be dropped by the caller.
  noteStreamReset(err: unknown): boolean {
    if (!this.connected || this.removed || this.session.closed || this.session.destroyed) return false;
    if (!isStreamReset(err)) return false;
    this.markSuspect();
    return true;
  }

  noteActivity(): void {
    if (!this.accepting) return;
    this.lastProofAt = this.now();
    this.suspect = false;
    this.schedule();
  }

  probe(): Promise<boolean> {
    if (!this.usable()) return Promise.resolve(false);
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.ping().then((ok) => {
      if (!ok || !this.usable()) this.drop("upstream ping timeout");
      return ok && this.usable();
    }).finally(() => {
      this.probePromise = undefined;
    });
    return this.probePromise;
  }

  shutdown(): void {
    this.remove("upstream replaced", false, false);
    if (this.destroyed) return;
    try {
      this.session.close();
    } catch {
      this.destroySession("upstream replaced");
    }
  }

  drop(reason: string, log = true): void {
    this.remove(reason, true, log);
  }

  retire(reason: string): void {
    this.remove(reason, false, true);
  }

  private ping(): Promise<boolean> {
    if (!this.usable()) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
          this.lastProofAt = this.now();
          this.suspect = false;
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), this.pingTimeoutMs);
      let sent = false;
      try {
        sent = this.session.ping((err) => finish(!err));
      } catch {
        sent = false;
      }
      if (!sent) finish(false);
    });
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.accepting) return;
    const age = Math.max(this.now() - this.lastProofAt, 0);
    const wait = age >= this.intervalMs ? 0 : this.intervalMs - age;
    const timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.accepting) return;
      void this.probe().finally(() => this.schedule());
    }, wait);
    unrefTimer(timer);
    this.timer = timer;
  }

  private watchSocket(): void {
    if (this.socketWatched) return;
    this.socketWatched = true;
    let socket: { on?: (event: string, listener: (err: unknown) => void) => unknown };
    try {
      socket = this.session.socket;
    } catch {
      return;
    }
    // setKeepAlive and other socket options throw on Bun's HTTP/2 wrapper
    // ("sockets should not be directly manipulated"). PINGs cover silent death;
    // error and close cover a reset the session has not surfaced yet.
    try {
      socket.on?.("error", (err: unknown) => {
        if (this.removed) return;
        if (this.noteStreamReset(err)) return;
        this.drop("upstream socket error");
      });
      socket.on?.("close", () => {
        if (!this.removed) this.retire("upstream socket closed");
      });
    } catch {
      // same wrapper, no listeners; session error/close/PING still run
    }
  }

  private socketDestroyed(): boolean {
    try {
      return Boolean(this.session.socket.destroyed);
    } catch {
      return true;
    }
  }

  private remove(reason: string, destroy: boolean, log: boolean): void {
    if (this.removed) {
      if (destroy) this.destroySession(reason);
      return;
    }
    this.removed = true;
    this.accepting = false;
    this.clearTimer();
    this.unpool();
    if (log && this.connected) this.onDrop(`upstream ${this.host} dropped (${reason})`);
    if (destroy) this.destroySession(reason);
  }

  private destroySession(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // On Bun, session.destroy(err) rethrows `err` and leaves the TCP socket
    // open when the handshake never finished. An established session must not
    // be reset this way: Windows then reports ECONNRESET on the peer.
    if (!this.connected) {
      try {
        const socket = this.session.socket as { resetAndDestroy?: () => void };
        if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      } catch {
        // already disconnected, or this runtime rejects the call
      }
    }
    try {
      this.session.destroy(new Error(reason));
    } catch {
      // Bun rethrows the error passed to destroy().
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function isStreamReset(err: unknown): boolean {
  const code = typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string" ? (err as { code: string }).code : "";
  const message = err instanceof Error ? err.message : "";
  return code === "ECONNRESET" || code === "EPIPE" || message.includes("ECONNRESET") || message.includes("EPIPE");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}
