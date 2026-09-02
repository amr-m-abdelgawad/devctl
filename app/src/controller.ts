import { createConnection, type Socket } from "node:net";
import { spawn } from "bun";
import { type DevctlConfig, load, stopOnExit } from "./config/index.ts";
import { KindGeneral, hintError, parseError, wrapError } from "./errors.ts";
import { type BusEvent } from "./events.ts";
import { type LogEvent } from "./logs.ts";
import { type Plan } from "./services.ts";
import { bootstrapLogPath, socketPath } from "./storage.ts";
import { Supervisor } from "./supervisor.ts";
import type { Envelope, LogsRequest, ReloadResult, StartRequest, StatusSnapshot } from "./types.ts";

const DIAL_RETRY_MS = 50;
const DIAL_TIMEOUT_MS = 8_000;
const TRY_DIAL_MS = 200;
const RPC_CALL_TIMEOUT_MS = 30_000;

export class Client {
  private readonly socket: Socket;
  private buf = "";
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners: Array<(ev: BusEvent) => void> = [];
  private nextID = 0;

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
      socket.once("connect", () => resolve(new Client(socket)));
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
  const cmd = supervisorSpawnCommand(process.execPath, process.argv[1] ?? "", Bun.isStandaloneExecutable === true, [
    "_supervisor",
    "--repo",
    repoRoot,
    "--config",
    configPath,
  ]);
  const child = spawn({
    cmd,
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
  local?: Supervisor;

  constructor(cfg: DevctlConfig) {
    this.cfg = cfg;
  }

  async start(req: StartRequest): Promise<Plan> {
    if (this.local && req.detach === true) {
      await this.local.shutdown(false);
      this.local = undefined;
      this.client = await ensureSupervisor(this.cfg.repoRoot, this.cfg.configPath);
    }
    const raw = await this.call("start", req);
    return raw as Plan;
  }

  async stop(services: string[]): Promise<void> {
    await this.call("stop", { services });
  }

  async restart(services: string[]): Promise<void> {
    await this.call("restart", { services });
  }

  async status(): Promise<StatusSnapshot> {
    return (await this.call("status", null)) as StatusSnapshot;
  }

  async logs(req: LogsRequest): Promise<LogEvent[]> {
    const raw = (await this.call("logs", req)) as { events?: LogEvent[] };
    return raw.events ?? [];
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

  async clearLogs(): Promise<void> {
    await this.call("logs_clear", null);
  }

  async invalidateAuth(): Promise<void> {
    await this.call("auth_invalidate", null);
  }

  onEvent(handler: (ev: BusEvent) => void): () => void {
    if (this.local) {
      return this.local.subscribe(handler);
    }
    if (this.client) {
      return this.client.onEvent(handler);
    }
    return () => undefined;
  }

  async close(opts?: { detach?: boolean; shutdownSupervisor?: boolean }): Promise<void> {
    if (this.client) {
      try {
        if (opts?.shutdownSupervisor === true && opts.detach !== true) {
          const shutdownTimeout = Math.max(5_000, this.cfg.shutdown.grace_seconds * 1_000 + 2_000);
          await this.client.call("shutdown", { stop_services: true }, shutdownTimeout);
        }
      } finally {
        this.client.close();
      }
    }
    if (this.local) {
      const detach = opts?.detach === true || this.local.isDetached();
      const stop = detach ? false : stopOnExit(this.cfg.shutdown);
      await this.local.shutdown(stop);
    }
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    if (this.local) {
      return this.local.dispatch(method, params);
    }
    if (!this.client) {
      throw wrapError(KindGeneral, "supervisor is not running", new Error("no client"));
    }
    return this.client.call(method, params);
  }
}

export async function openController(startDir: string, configPath: string, startSupervisor: boolean): Promise<Controller> {
  const cfg = load(startDir, configPath);
  const ctrl = new Controller(cfg);
  if (!startSupervisor) {
    ctrl.client = await tryDial(cfg.repoRoot);
    return ctrl;
  }
  ctrl.client = await ensureSupervisor(cfg.repoRoot, cfg.configPath);
  return ctrl;
}

export async function openAttach(startDir: string, configPath: string): Promise<Controller> {
  const cfg = load(startDir, configPath);
  const ctrl = new Controller(cfg);
  const existing = await tryDial(cfg.repoRoot);
  if (!existing) {
    throw hintError(KindGeneral, "supervisor is not running", "run `devctl start --detach` before `devctl attach`");
  }
  ctrl.client = existing;
  return ctrl;
}

export async function openLocal(startDir: string, configPath: string): Promise<Controller> {
  const cfg = load(startDir, configPath);
  const ctrl = new Controller(cfg);
  const existing = await tryDial(cfg.repoRoot);
  if (existing) {
    ctrl.client = existing;
    return ctrl;
  }
  ctrl.local = new Supervisor(cfg);
  await ctrl.local.run({ autoStartProxy: false });
  return ctrl;
}
