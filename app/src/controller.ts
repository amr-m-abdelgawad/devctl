import { createConnection, type Socket } from "node:net";
import { spawn } from "bun";
import { type DevctlConfig, defaultConfig, load } from "./config/index.ts";
import { resolveDaemonTarget } from "./daemon.ts";
import { osEnviron } from "./environment.ts";
import { KindGeneral, hintError, parseError, wrapError } from "./errors.ts";
import { type BusEvent } from "./events.ts";
import { type LogEvent, type LogFacets, type LogFilter, type LogPage, type LogPageRequest } from "./logs.ts";
import { type Plan } from "./services.ts";
import { bootstrapLogPath, socketPath } from "./storage.ts";
import type { Envelope, LogsRequest, ReloadResult, StartRequest, StatusSnapshot } from "./types.ts";
import { RPC_PROTOCOL_VERSION, VERSION } from "./version.ts";

const DIAL_RETRY_MS = 50;
const DIAL_TIMEOUT_MS = 8_000;
const TRY_DIAL_MS = 200;
const RPC_CALL_TIMEOUT_MS = 30_000;
// RPC methods a client must still be able to send to an incompatible
// daemon: removing it (`down` → the "shutdown" call, made directly on
// Client rather than through Controller.call) and reading its logs so the
// user has something to look at before deciding to run `down`.
const ALWAYS_ALLOWED_METHODS = new Set(["logs", "logs_page", "logs_stats"]);

export type DaemonCompat = {
  compatible: boolean;
  // No `protocol` field on the ping response at all — a daemon from before
  // this handshake existed, not merely a different protocol version.
  legacy: boolean;
  daemonVersion?: string;
  daemonProtocol?: number;
};

// A daemon that answers ping but is otherwise incompatible still needs a
// clear reason, since "attached daemon speaks a different RPC protocol" and
// "attached daemon predates version negotiation entirely" call for the same
// remedy (`devctl down`) but are worth distinguishing in the message.
export function describeIncompatibility(compat: DaemonCompat): string {
  if (compat.legacy) {
    return "attached daemon predates the client/daemon compatibility handshake";
  }
  return `attached daemon speaks RPC protocol ${compat.daemonProtocol ?? "unknown"}; this client speaks ${RPC_PROTOCOL_VERSION}`;
}

// Same protocol, different binary build — not blocking, just worth telling
// the user so a stale detached daemon doesn't go unnoticed indefinitely.
export function compatWarning(compat: DaemonCompat): string | undefined {
  if (compat.compatible && compat.daemonVersion !== undefined && compat.daemonVersion !== VERSION) {
    return `attached daemon is devctl ${compat.daemonVersion}; this client is ${VERSION} (run \`devctl down\` then start again to update it)`;
  }
  return undefined;
}

// Shared by Controller.call() and any lighter-weight caller (status,
// down, daemon logs) that talks to a Client directly instead of through a
// Controller.
export function assertMethodAllowed(client: Client, method: string): void {
  if (!client.compat.compatible && !ALWAYS_ALLOWED_METHODS.has(method)) {
    throw hintError(KindGeneral, describeIncompatibility(client.compat), "run `devctl down` to stop it, then start again");
  }
}

export class Client {
  private readonly socket: Socket;
  private buf = "";
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners: Array<(ev: BusEvent) => void> = [];
  private nextID = 0;
  // Populated by dial() before it resolves — every Client a caller ever
  // sees already has a real handshake result, not the optimistic default.
  compat: DaemonCompat = { compatible: true, legacy: false };
  session = "";

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        this.onLine(line);
      }
    });
    socket.on("error", (err) => this.rejectPending(err instanceof Error ? err : new Error(String(err))));
    socket.on("close", () => this.rejectPending(new Error("supervisor connection closed")));
  }

  private onLine(line: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(line) as Envelope;
    } catch {
      return;
    }
    if (env.event) {
      for (const listener of this.listeners) {
        listener(env.event as BusEvent);
      }
      return;
    }
    const pending = env.id ? this.pending.get(env.id) : undefined;
    if (!pending) {
      return;
    }
    this.pending.delete(env.id ?? "");
    clearTimeout(pending.timer);
    if (env.error) {
      pending.reject(parseError({ error: env.error, kind: env.kind as import("./errors.ts").ErrorKind | undefined, hint: env.hint, service: env.service }));
      return;
    }
    pending.resolve(env.result);
  }

  onEvent(handler: (ev: BusEvent) => void): () => void {
    this.listeners.push(handler);
    return () => {
      const idx = this.listeners.indexOf(handler);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    };
  }

  call(method: string, params: unknown, timeoutMs = RPC_CALL_TIMEOUT_MS): Promise<unknown> {
    this.nextID += 1;
    const id = String(this.nextID);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  close(): void {
    this.rejectPending(new Error("supervisor connection closed"));
    this.socket.destroy();
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

export function dial(repoRoot: string, timeoutMs: number): Promise<Client> {
  const path = socketPath(repoRoot);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const socket = createConnection(path);
      socket.once("connect", () => {
        const client = new Client(socket);
        void handshake(client).finally(() => resolve(client));
      });
      socket.once("error", (err) => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(hintError(KindGeneral, "supervisor is not running", "run `devctl start` or `devctl attach` after starting services"));
          return;
        }
        setTimeout(tryOnce, DIAL_RETRY_MS);
        void err;
      });
    };
    tryOnce();
  });
}

// Runs once per dial, before the caller ever sees the Client, so
// Client.compat and Client.session are always real by the time any RPC
// beyond ping is attempted. A ping failure leaves the optimistic default in
// place — whatever RPC the caller actually wanted will surface the real
// connection error on its own.
async function handshake(client: Client): Promise<void> {
  let raw: unknown;
  try {
    raw = await client.call("ping", null, DIAL_TIMEOUT_MS);
  } catch {
    return;
  }
  const rec = isRecord(raw) ? raw : {};
  if (typeof rec.session === "string") {
    client.session = rec.session;
  }
  const protocol = typeof rec.protocol === "number" ? rec.protocol : undefined;
  const version = typeof rec.version === "string" ? rec.version : undefined;
  if (protocol === undefined) {
    client.compat = { compatible: false, legacy: true, daemonVersion: version };
    return;
  }
  client.compat = { compatible: protocol === RPC_PROTOCOL_VERSION, legacy: false, daemonVersion: version, daemonProtocol: protocol };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function tryDial(repoRoot: string): Promise<Client | undefined> {
  try {
    return await dial(repoRoot, TRY_DIAL_MS);
  } catch {
    return undefined;
  }
}

// A `bun run script.ts` process needs the script path as argv[1] so the Bun
// runtime knows what to execute; a `bun build --compile` binary already *is*
// the program, so passing that same argv[1] (whatever subcommand the calling
// process was invoked with, e.g. "status") makes it mistake that word for a
// second subcommand. Bun.isStandaloneExecutable tells them apart; isolated
// as a pure function so tests can force both branches without compiling.
export function supervisorSpawnCommand(execPath: string, scriptArg: string, isStandalone: boolean, args: string[]): string[] {
  return isStandalone ? [execPath, ...args] : [execPath, scriptArg, ...args];
}

export async function ensureSupervisor(repoRoot: string, configPath: string): Promise<Client> {
  const existing = await tryDial(repoRoot);
  if (existing) {
    return existing;
  }
  const bootstrapLog = bootstrapLogPath(repoRoot);
  // --config is root's own global option, so with root's positional-options
  // parsing it must precede the _supervisor subcommand name; --repo belongs
  // to _supervisor itself and can stay after it.
  const cmd = supervisorSpawnCommand(process.execPath, process.argv[1] ?? "", Bun.isStandaloneExecutable === true, [
    "--config",
    configPath,
    "_supervisor",
    "--repo",
    repoRoot,
  ]);
  const child = spawn({
    cmd,
    // Bun.spawn()'s default env is a snapshot of process.env from when
    // *this* process launched, not a live view of it — so without this,
    // anything this process set on its own process.env at runtime (e.g.
    // gcp-env.ts's METADATA_SERVER_DETECTION/GCE_METADATA_TIMEOUT, always
    // set before the CLI even parses args) would silently not reach the
    // supervisor it spawns.
    env: process.env,
    stdout: "ignore",
    stderr: Bun.file(bootstrapLog),
    stdin: "ignore",
    detached: true,
  });
  child.unref();
  try {
    return await dial(repoRoot, DIAL_TIMEOUT_MS);
  } catch {
    throw hintError(KindGeneral, "supervisor failed to start", `see ${bootstrapLog} for details`);
  }
}

export class Controller {
  cfg: DevctlConfig;
  client?: Client;

  constructor(cfg: DevctlConfig) {
    this.cfg = cfg;
  }

  async start(req: StartRequest): Promise<Plan> {
    const raw = await this.call("start", { ...req, client_env: osEnviron() });
    return raw as Plan;
  }

  async stop(services: string[]): Promise<void> {
    await this.call("stop", { services });
  }

  async restart(services: string[], cascade?: boolean): Promise<void> {
    await this.call("restart", { services, cascade: cascade === true, client_env: osEnviron() });
  }

  async status(): Promise<StatusSnapshot> {
    return (await this.call("status", null)) as StatusSnapshot;
  }

  // The daemon's last-known-good in-memory configuration, with real values
  // intact — local RPC only (dispatch() never exposes it through MCP). This
  // is the only correct source of "effective config" once attached: a
  // locally parsed file can already disagree with what the attached daemon
  // is actually running.
  async configSnapshot(): Promise<DevctlConfig> {
    return (await this.call("config_snapshot", null)) as DevctlConfig;
  }

  async logs(req: LogsRequest): Promise<LogEvent[]> {
    const raw = (await this.call("logs", req)) as { events?: LogEvent[] };
    return raw.events ?? [];
  }

  async logsPage(req: LogFilter & LogPageRequest): Promise<LogPage> {
    return (await this.call("logs_page", req)) as LogPage;
  }

  // Deliberately lightweight: no event payload, so a follow-mode consumer
  // can poll this every couple of seconds for live facet counts without
  // re-fetching (and re-transferring) events it already has.
  async logsStats(req: LogFilter): Promise<LogFacets> {
    return (await this.call("logs_stats", req)) as LogFacets;
  }

  async proxyStart(): Promise<void> {
    await this.call("proxy_start", null);
  }

  async proxyStop(): Promise<void> {
    await this.call("proxy_stop", null);
  }

  async mcpStart(opts?: { port?: number }): Promise<void> {
    await this.call("mcp_start", opts ?? null);
  }

  async mcpStop(): Promise<void> {
    await this.call("mcp_stop", null);
  }

  async reload(): Promise<ReloadResult> {
    return (await this.call("reload", null)) as ReloadResult;
  }

  async invalidateAuth(): Promise<void> {
    await this.call("auth_invalidate", null);
  }

  onEvent(handler: (ev: BusEvent) => void): () => void {
    if (this.client) {
      return this.client.onEvent(handler);
    }
    return () => undefined;
  }

  async close(opts?: { detach?: boolean; shutdownSupervisor?: boolean }): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      if (opts?.shutdownSupervisor === true && opts.detach !== true) {
        const shutdownTimeout = Math.max(5_000, this.cfg.shutdown.grace_seconds * 1_000 + 2_000);
        await this.client.call("shutdown", { stop_services: true }, shutdownTimeout);
      }
    } finally {
      this.client.close();
    }
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    if (!this.client) {
      throw wrapError(KindGeneral, "supervisor is not running", new Error("no client"));
    }
    assertMethodAllowed(this.client, method);
    return this.client.call(method, params);
  }
}

// Same protocol, different build — never blocking, just worth surfacing so
// a stale detached daemon doesn't go unnoticed indefinitely.
function warnIfVersionMismatch(client: Client | undefined): void {
  const warning = client && compatWarning(client.compat);
  if (warning) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}

// A lighter-weight alternative to openController/openAttach for commands
// (status, down, daemon logs) that only need to find and dial a daemon, not
// parse and validate a full DevctlConfig — repository/session lookup here
// is deliberately independent of local config parsing, via
// resolveDaemonTarget's discovery-then-state-scan fallback, so a deleted
// .devctl directory can never make a still-live daemon unreachable.
export async function findDaemon(startDir: string, explicitRepo: string, explicitConfig = ""): Promise<{ repoRoot: string; client?: Client }> {
  const target = resolveDaemonTarget(startDir, explicitRepo, explicitConfig);
  if (!target) {
    throw hintError(
      KindGeneral,
      "no devctl configuration found",
      "run `devctl setup`, create a .devctl/config.yaml in the repository root, or pass --repo",
    );
  }
  const client = await tryDial(target.repoRoot);
  warnIfVersionMismatch(client);
  return { repoRoot: target.repoRoot, client };
}

export async function openController(startDir: string, configPath: string, startSupervisor: boolean): Promise<Controller> {
  const cfg = load(startDir, configPath);
  const ctrl = new Controller(cfg);
  if (!startSupervisor) {
    ctrl.client = await tryDial(cfg.repoRoot);
    warnIfVersionMismatch(ctrl.client);
    return ctrl;
  }
  ctrl.client = await ensureSupervisor(cfg.repoRoot, cfg.configPath);
  warnIfVersionMismatch(ctrl.client);
  return ctrl;
}

// The daemon's config_snapshot is the only correct source of "effective
// config" once attached — see Controller.configSnapshot(). The placeholder
// passed to `new Controller()` here is discarded the instant the real
// snapshot comes back; nothing reads it in between.
async function attachAndSnapshot(client: Client): Promise<Controller> {
  const ctrl = new Controller(defaultConfig());
  ctrl.client = client;
  warnIfVersionMismatch(ctrl.client);
  ctrl.cfg = await ctrl.configSnapshot();
  return ctrl;
}

export async function openAttach(startDir: string, configPath: string): Promise<Controller> {
  const target = resolveDaemonTarget(startDir, "", configPath);
  const existing = target ? await tryDial(target.repoRoot) : undefined;
  if (!existing) {
    throw hintError(KindGeneral, "supervisor is not running", "run `devctl start` before `devctl attach`");
  }
  return attachAndSnapshot(existing);
}

// The TUI's own bootstrap: locate and attach to an existing daemon first,
// independent of local config parsing, so an already-broken or since-deleted
// config file can never make an otherwise-healthy attached daemon
// unreachable (config_snapshot is the effective config either way). Local
// config parsing only comes into play — and only then decides what happens
// next — when no daemon is reachable: a valid config spawns a fresh daemon,
// a missing one lets KindConfigurationMissing propagate so the TUI opens
// setup, and anything else is a real error with nothing started.
export async function openTui(startDir: string, configPath: string): Promise<Controller> {
  const target = resolveDaemonTarget(startDir, "", configPath);
  const existing = target ? await tryDial(target.repoRoot) : undefined;
  if (existing) {
    return attachAndSnapshot(existing);
  }
  const cfg = load(startDir, configPath);
  const ctrl = new Controller(cfg);
  ctrl.client = await ensureSupervisor(cfg.repoRoot, cfg.configPath);
  warnIfVersionMismatch(ctrl.client);
  ctrl.cfg = await ctrl.configSnapshot();
  return ctrl;
}
