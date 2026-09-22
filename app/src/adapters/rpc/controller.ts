import { createConnection, type Socket } from "node:net";
import { clearInterval as clearResumeInterval, setInterval as resumeInterval } from "node:timers";
import { spawn } from "bun";
import { type DevctlConfig, defaultConfig, discover, load, loadOrEmpty } from "../config/index.ts";
import { resolveDaemonTarget } from "../daemon/daemon.ts";
import { osEnviron } from "../environment/environment.ts";
import { KindGeneral, hintError, parseError, wrapError } from "../../shared/errors.ts";
import { type BusEvent } from "../../shared/events.ts";
import { type LogEvent, type LogFacets, type LogFilter, type LogPage, type LogPageRequest } from "../storage/logs.ts";
import type { LlmCall, LlmCallFilter, LlmCallPage, LlmCallPageRequest } from "../../domain/llm/llm.ts";
import type { TrafficCall, TrafficCallFilter, TrafficCallPage, TrafficCallPageRequest } from "../../domain/traffic/traffic.ts";
import { type Plan } from "../../domain/service/services.ts";
import { bootstrapLogHint, bootstrapLogPath, killRepoSupervisor, persistedConfigOverlay, processAlive, readBootstrapLog, readRepoLock, rotateBootstrapLog, socketPath, readRpcToken, type PersistedState, readPersistedState } from "../storage/storage.ts";
import type { Envelope } from "../../types.ts";
import type { IdentitySnapshot, LogsRequest, ReloadResult, StartRequest, StatusSnapshot, TraceResponse } from "../../domain/status.ts";
import { RPC_PROTOCOL_VERSION, VERSION } from "../../version.ts";

const DIAL_RETRY_MS = 50;
const DIAL_TIMEOUT_MS = 8_000;
// Waiting for a *freshly spawned* daemon to bind its socket, not for an
// already-running one to answer. A cold cross-process spawn (a new Bun
// runtime plus socket bind) can take noticeably longer than a ping to a live
// daemon — especially on Windows and loaded CI runners — so this gets more
// grace than DIAL_TIMEOUT_MS to avoid spurious "supervisor failed to start".
const BOOTSTRAP_DIAL_TIMEOUT_MS = 15_000;
const TRY_DIAL_MS = 200;
const RPC_CALL_TIMEOUT_MS = 30_000;
const PING_PROBE_MS = 1_000;
const REDIAL_MS = 3_000;
const QUIT_RPC_MS = 3_000;
const REAP_WAIT_MS = 2_000;
const RESUME_POLL_MS = 1_000;
export const RESUME_GAP_MS = 15_000;
const COMMAND_RPC_TIMEOUT_MS = 24 * 60 * 60 * 1000;
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
export function assertMethodAllowed(client: { compat: DaemonCompat }, method: string): void {
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
  private readonly auth: string;
  // Populated by dial() before it resolves — every Client a caller ever
  // sees already has a real handshake result, not the optimistic default.
  compat: DaemonCompat = { compatible: true, legacy: false };
  session = "";

  constructor(socket: Socket, auth = "") {
    this.socket = socket;
    this.auth = auth;
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
      pending.reject(parseError({ error: env.error, kind: env.kind as import("../../shared/errors.ts").ErrorKind | undefined, hint: env.hint, service: env.service }));
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
    if (this.socket.destroyed) {
      return Promise.reject(new Error("supervisor connection closed"));
    }
    this.nextID += 1;
    const id = String(this.nextID);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params, auth: this.auth }) + "\n");
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
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      action();
    };
    const fail = (err: Error): void => finish(() => reject(err));
    const tryOnce = (): void => {
      if (settled || Date.now() >= deadline) {
        fail(hintError(KindGeneral, "supervisor is not running", "run `devctl start` or `devctl attach` after starting services"));
        return;
      }
      const socket = createConnection(path);
      const onError = (): void => {
        socket.destroy();
        if (settled || Date.now() >= deadline) {
          fail(hintError(KindGeneral, "supervisor is not running", "run `devctl start` or `devctl attach` after starting services"));
          return;
        }
        setTimeout(tryOnce, DIAL_RETRY_MS);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        const client = new Client(socket, readRpcToken(repoRoot));
        const pingBudget = Math.min(DIAL_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
        void handshake(client, pingBudget).then((ok) => {
          if (!ok) {
            client.close();
            fail(hintError(KindGeneral, "supervisor is not responding", "start devctl again; a supervisor that stops answering is replaced and its services are kept"));
            return;
          }
          finish(() => resolve(client));
        });
      });
    };
    tryOnce();
  });
}

// Runs once per dial, before the caller ever sees the Client, so
// Client.compat and Client.session are always real by the time any RPC
// beyond ping is attempted. A ping that never returns means the socket is
// open but the supervisor is not reading it — dial rejects instead of
// handing back a client that will time out every later call.
async function handshake(client: Client, timeoutMs: number): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await client.call("ping", null, timeoutMs);
  } catch {
    return false;
  }
  const rec = isRecord(raw) ? raw : {};
  if (typeof rec.session === "string") {
    client.session = rec.session;
  }
  const protocol = typeof rec.protocol === "number" ? rec.protocol : undefined;
  const version = typeof rec.version === "string" ? rec.version : undefined;
  if (protocol === undefined) {
    client.compat = { compatible: false, legacy: true, daemonVersion: version };
    return true;
  }
  client.compat = { compatible: protocol === RPC_PROTOCOL_VERSION, legacy: false, daemonVersion: version, daemonProtocol: protocol };
  return true;
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

export function hostClockJumped(previousMs: number, nowMs: number, gapMs = RESUME_GAP_MS): boolean {
  return nowMs - previousMs >= gapMs;
}

export function isRpcTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out after \d+ms$/.test(err.message);
}

async function connectSupervisor(repoRoot: string): Promise<Client | undefined> {
  const existing = await tryDial(repoRoot);
  if (existing) {
    return existing;
  }
  return takeOverUnresponsive(repoRoot);
}

// A lock whose process is alive but never answers ping is the supervisor
// left behind by a WSL or dev-container suspend: the socket may still
// accept, and the child processes still hold their ports. Replace it so
// the next supervisor can adopt those processes.
async function takeOverUnresponsive(repoRoot: string): Promise<Client | undefined> {
  const lock = readRepoLock(repoRoot);
  if (!lock || !processAlive(lock.pid)) {
    return undefined;
  }
  try {
    return await dial(repoRoot, BOOTSTRAP_DIAL_TIMEOUT_MS);
  } catch {
    if (processAlive(lock.pid)) {
      killRepoSupervisor(repoRoot);
      await waitForExit(lock.pid, REAP_WAIT_MS);
    }
    return undefined;
  }
}

function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (!processAlive(pid) || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(tick, DIAL_RETRY_MS);
    };
    tick();
  });
}

export async function ensureSupervisor(repoRoot: string, configPath: string): Promise<Client> {
  const existing = await connectSupervisor(repoRoot);
  if (existing) {
    return existing;
  }
  rotateBootstrapLog(repoRoot);
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
    // supervisor it spawns. Copy so a later DEVCTL_HOME mutation in this
    // process cannot change what the child already received.
    env: { ...process.env },
    stdout: "ignore",
    stderr: Bun.file(bootstrapLog),
    stdin: "ignore",
    detached: true,
  });
  try {
    const client = await waitForSupervisorBind(repoRoot, BOOTSTRAP_DIAL_TIMEOUT_MS, child.exited);
    // Only after the socket is up: the daemon is meant to outlive this CLI.
    // Unref-before-dial used to leak every spawn that failed to bind —
    // including bun test processes that then exited and left PPID-1 orphans.
    child.unref();
    return client;
  } catch {
    await reapSupervisorChild(child);
    throw hintError(KindGeneral, "supervisor failed to start", bootstrapLogHint(bootstrapLog, readBootstrapLog(repoRoot)));
  }
}

const SUPERVISOR_REAP_MS = 1_000;

function waitForSupervisorBind(repoRoot: string, timeoutMs: number, exited: Promise<number>): Promise<Client> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      action();
    };
    void exited.then((code) => {
      finish(() => reject(new Error(`supervisor exited (code ${code}) before accepting connections`)));
    });
    void dial(repoRoot, timeoutMs).then(
      (client) => finish(() => resolve(client)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}

export async function reapSupervisorChild(child: { pid?: number; kill: (signal?: "SIGKILL") => void; exited: Promise<number> }): Promise<void> {
  const pid = child.pid;
  try {
    child.kill("SIGKILL");
  } catch {
    // already exited
  }
  if (pid !== undefined && pid > 0 && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  await Promise.race([
    child.exited.then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, SUPERVISOR_REAP_MS);
    }),
  ]);
}

export class Controller {
  cfg: DevctlConfig;
  client?: Client;
  previousPersisted?: PersistedState;
  private readonly busListeners = new Set<(ev: BusEvent) => void>();
  private detachBus: (() => void) | undefined;
  private resumeTimer: ReturnType<typeof resumeInterval> | undefined;
  private lastResumeMark = Date.now();
  private recovering: Promise<void> | undefined;
  private closed = false;
  private attachedRepo = "";

  constructor(cfg: DevctlConfig) {
    this.cfg = cfg;
  }

  attachClient(client: Client, repoRoot?: string): void {
    this.detachBus?.();
    this.detachBus = undefined;
    this.client = client;
    if (repoRoot) {
      this.attachedRepo = repoRoot;
    }
    if (this.busListeners.size > 0) {
      this.bindBus();
    }
    if (!this.closed) {
      this.armResumeWatch();
    }
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

  async runTask(name: string): Promise<{ task: string; code: number; stdout: string; stderr: string }> {
    return (await this.call("run_task", { name, client_env: osEnviron() }, COMMAND_RPC_TIMEOUT_MS)) as { task: string; code: number; stdout: string; stderr: string };
  }

  async execService(service: string, command: string[], printEnv = false): Promise<{ service: string; code: number; stdout: string; stderr: string; environment?: Record<string, string> }> {
    return (await this.call("exec", { service, command, print_env: printEnv, client_env: osEnviron() }, COMMAND_RPC_TIMEOUT_MS)) as { service: string; code: number; stdout: string; stderr: string; environment?: Record<string, string> };
  }

  async status(): Promise<StatusSnapshot> {
    return (await this.call("status", null)) as StatusSnapshot;
  }

  async refreshAuth(): Promise<IdentitySnapshot> {
    return (await this.call("auth_refresh", null)) as IdentitySnapshot;
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

  async getTrace(traceId: string): Promise<TraceResponse> {
    return (await this.call("get_trace", { trace_id: traceId })) as TraceResponse;
  }

  async traceRequest(requestId: string): Promise<TraceResponse> {
    return (await this.call("trace_request", { request_id: requestId })) as TraceResponse;
  }

  async llmCallsPage(req: LlmCallFilter & LlmCallPageRequest): Promise<LlmCallPage> {
    return (await this.call("llm_calls_page", req)) as LlmCallPage;
  }

  async getLlmCall(id: string): Promise<LlmCall | undefined> {
    const raw = await this.call("get_llm_call", { id });
    return raw === null || raw === undefined ? undefined : raw as LlmCall;
  }

  async trafficCallsPage(req: TrafficCallFilter & TrafficCallPageRequest): Promise<TrafficCallPage> {
    return (await this.call("traffic_calls_page", req)) as TrafficCallPage;
  }

  async getTrafficCall(id: string): Promise<TrafficCall | undefined> {
    const raw = await this.call("get_traffic_call", { id });
    return raw === null || raw === undefined ? undefined : raw as TrafficCall;
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

  async mcpRotate(): Promise<void> {
    await this.call("mcp_rotate", null);
  }

  async webStart(): Promise<{ url: string }> {
    const res = (await this.call("web_start", null)) as { url?: string };
    return { url: res.url ?? "" };
  }

  async webStop(): Promise<void> {
    await this.call("web_stop", null);
  }

  // Local RPC only, deliberately: this is not reachable through McpHost, so a
  // connected agent cannot re-enable a tool its operator turned off.
  async mcpSetTools(disabled: readonly string[]): Promise<string[]> {
    const res = (await this.call("mcp_set_tools", { disabled: [...disabled] })) as { disabled_tools?: string[] };
    return res.disabled_tools ?? [];
  }

  async reload(): Promise<ReloadResult> {
    return (await this.call("reload", null)) as ReloadResult;
  }

  setServiceEnvironment(service: string, name: string): Promise<{ service: string; env: string }> {
    return this.call("set_service_env", { service, name }) as Promise<{ service: string; env: string }>;
  }

  async invalidateAuth(): Promise<void> {
    await this.call("auth_invalidate", null);
  }

  onEvent(handler: (ev: BusEvent) => void): () => void {
    this.busListeners.add(handler);
    this.bindBus();
    return () => {
      this.busListeners.delete(handler);
    };
  }

  async shutdown(opts: { stopServices: boolean }): Promise<void> {
    if (!this.client) {
      return;
    }
    const shutdownTimeout = Math.max(5_000, this.cfg.shutdown.grace_seconds * 1_000 + 2_000);
    await this.client.call("shutdown", { stop_services: opts.stopServices }, shutdownTimeout);
  }

  async close(opts?: { detach?: boolean; shutdownSupervisor?: boolean }): Promise<void> {
    this.closed = true;
    this.stopResumeWatch();
    const client = this.client;
    if (!client) {
      return;
    }
    try {
      if (opts?.shutdownSupervisor === true && opts.detach !== true) {
        await client.call("shutdown", { stop_services: true }, QUIT_RPC_MS);
      }
    } catch {
      // A supervisor that stopped reading the socket must not hold the TTY.
    } finally {
      this.detachBus?.();
      this.detachBus = undefined;
      client.close();
      this.client = undefined;
    }
  }

  private bindBus(): void {
    this.detachBus?.();
    this.detachBus = undefined;
    if (!this.client) {
      return;
    }
    this.detachBus = this.client.onEvent((ev) => {
      for (const handler of this.busListeners) {
        handler(ev);
      }
    });
  }

  private armResumeWatch(): void {
    if (this.resumeTimer !== undefined) {
      return;
    }
    this.lastResumeMark = Date.now();
    this.resumeTimer = resumeInterval(() => {
      const now = Date.now();
      const previous = this.lastResumeMark;
      this.lastResumeMark = now;
      if (hostClockJumped(previous, now)) {
        void this.recoverSupervisor();
      }
    }, RESUME_POLL_MS);
    this.resumeTimer.unref();
  }

  private stopResumeWatch(): void {
    if (this.resumeTimer !== undefined) {
      clearResumeInterval(this.resumeTimer);
      this.resumeTimer = undefined;
    }
  }

  private async answersPing(): Promise<boolean> {
    if (!this.client) {
      return false;
    }
    try {
      await this.client.call("ping", null, PING_PROBE_MS);
      return true;
    } catch {
      return false;
    }
  }

  private recoverSupervisor(): Promise<void> {
    if (!this.recovering) {
      this.recovering = this.recoverSupervisorOnce().finally(() => {
        this.recovering = undefined;
      });
    }
    return this.recovering;
  }

  private async recoverSupervisorOnce(): Promise<void> {
    if (this.closed) {
      return;
    }
    const repo = this.attachedRepo || this.cfg.repoRoot;
    const configPath = this.cfg.configPath;
    this.detachBus?.();
    this.detachBus = undefined;
    this.client?.close();
    this.client = undefined;
    try {
      this.attachClient(await dial(repo, REDIAL_MS), repo);
      return;
    } catch {
      // The socket is still dead. Replace the supervisor below.
    }
    const lock = readRepoLock(repo);
    if (lock && processAlive(lock.pid)) {
      killRepoSupervisor(repo);
      await waitForExit(lock.pid, REAP_WAIT_MS);
    }
    if (this.closed) {
      return;
    }
    this.attachClient(await ensureSupervisor(repo, configPath), repo);
  }

  private async call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.client) {
      throw wrapError(KindGeneral, "supervisor is not running", new Error("no client"));
    }
    assertMethodAllowed(this.client, method);
    try {
      return await this.client.call(method, params, timeoutMs);
    } catch (err) {
      if (method === "shutdown" || !isRpcTimeout(err)) {
        throw err;
      }
      if (await this.answersPing()) {
        throw err;
      }
      await this.recoverSupervisor();
      if (!this.client) {
        throw err;
      }
      assertMethodAllowed(this.client, method);
      return this.client.call(method, params, timeoutMs);
    }
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

function overlayFromPersisted(startDir: string, configPath: string): string | undefined {
  try {
    return persistedConfigOverlay(discover(startDir, configPath).repoRoot);
  } catch {
    return undefined;
  }
}

// allowMissingConfig is opt-in and belongs to exactly one caller: `devctl mcp
// --on`, which must be able to bring a daemon up in a repository that has no
// .devctl yet so an agent can be pointed at the MCP server and asked to
// create one. Every other command should still fail closed with "no devctl
// configuration found" rather than quietly operating on an empty config.
export async function openController(
  startDir: string,
  configPath: string,
  startSupervisor: boolean,
  opts?: { allowMissingConfig?: boolean },
): Promise<Controller> {
  const cfg = opts?.allowMissingConfig === true
    ? loadOrEmpty(startDir, configPath, { overlay: overlayFromPersisted(startDir, configPath) })
    : load(startDir, configPath, { overlay: overlayFromPersisted(startDir, configPath) });
  const ctrl = new Controller(cfg);
  if (!startSupervisor) {
    const client = await tryDial(cfg.repoRoot);
    if (client) {
      ctrl.attachClient(client, cfg.repoRoot);
    }
    warnIfVersionMismatch(ctrl.client);
    return ctrl;
  }
  ctrl.attachClient(await ensureSupervisor(cfg.repoRoot, cfg.configPath), cfg.repoRoot);
  warnIfVersionMismatch(ctrl.client);
  return ctrl;
}

// The daemon's config_snapshot is the only correct source of "effective
// config" once attached — see Controller.configSnapshot(). The placeholder
// passed to `new Controller()` here is discarded the instant the real
// snapshot comes back; nothing reads it in between.
async function attachAndSnapshot(client: Client, repoRoot: string): Promise<Controller> {
  const ctrl = new Controller(defaultConfig());
  ctrl.attachClient(client, repoRoot);
  warnIfVersionMismatch(ctrl.client);
  ctrl.cfg = await ctrl.configSnapshot();
  return ctrl;
}

export async function openAttach(startDir: string, configPath: string): Promise<Controller> {
  const target = resolveDaemonTarget(startDir, "", configPath);
  const existing = target ? await tryDial(target.repoRoot) : undefined;
  if (!target || !existing) {
    throw hintError(KindGeneral, "supervisor is not running", "run `devctl start` before `devctl attach`");
  }
  return attachAndSnapshot(existing, target.repoRoot);
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
  const existing = target ? await connectSupervisor(target.repoRoot) : undefined;
  if (existing && target) {
    return attachAndSnapshot(existing, target.repoRoot);
  }
  const cfg = load(startDir, configPath, { overlay: overlayFromPersisted(startDir, configPath) });
  const ctrl = new Controller(cfg);
  const leftover = readPersistedState(cfg.repoRoot);
  ctrl.attachClient(await ensureSupervisor(cfg.repoRoot, cfg.configPath), cfg.repoRoot);
  warnIfVersionMismatch(ctrl.client);
  ctrl.cfg = await ctrl.configSnapshot();
  if (leftover && leftover.processes.length > 0) {
    ctrl.previousPersisted = leftover;
  }
  return ctrl;
}
