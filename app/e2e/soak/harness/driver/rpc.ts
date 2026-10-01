// A raw client for the daemon's RPC socket, for drivers running inside the
// soak container: newline-delimited JSON with the repo's rpc-token, exactly
// what `devctl` itself speaks. Events the daemon pushes after the first
// authenticated call are read and counted, never left unread, unless the
// caller stops reading on purpose.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

export function devctlHome(): string {
  return process.env.DEVCTL_HOME ?? "/work/home";
}

/** The state directory of the one stack in this DEVCTL_HOME (or of the repo whose socket it holds). */
export function findStateDir(home = devctlHome()): string {
  const root = join(home, "state");
  const dirs = existsSync(root) ? readdirSync(root).map((name) => join(root, name)).filter((dir) => existsSync(join(dir, "devctl.sock"))) : [];
  if (dirs.length !== 1) {
    throw new Error(`expected one running stack under ${root}, found ${dirs.length}`);
  }
  return dirs[0]!;
}

export function daemonPid(stateDir: string): number {
  const lock = JSON.parse(readFileSync(join(stateDir, "devctl.lock"), "utf8")) as { pid?: number };
  if (typeof lock.pid !== "number") {
    throw new Error(`no pid in ${stateDir}/devctl.lock`);
  }
  return lock.pid;
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

export class RpcClient {
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  events = 0;
  eventBytes = 0;

  private constructor(
    private readonly socket: Socket,
    private readonly token: string,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", () => this.failAll(new Error("rpc socket error")));
    socket.on("close", () => this.failAll(new Error("rpc socket closed")));
  }

  /** `stateDir` defaults to the one stack running in DEVCTL_HOME. */
  static async open(stateDir: string | undefined = undefined): Promise<RpcClient> {
    stateDir ??= findStateDir();
    const token = readFileSync(join(stateDir, "rpc-token"), "utf8").trim();
    const socket = await new Promise<Socket>((resolve, reject) => {
      const conn = connect(join(stateDir, "devctl.sock"), () => resolve(conn));
      conn.once("error", reject);
    });
    return new RpcClient(socket, token);
  }

  call(method: string, params: unknown = null, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, params, auth: this.token })}\n`);
    });
  }

  /** Stops reading: the daemon's replies and events back up, as with a suspended TUI. */
  stopReading(): void {
    this.socket.pause();
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let newline = this.buf.indexOf("\n");
    while (newline >= 0) {
      const line = this.buf.slice(0, newline);
      this.buf = this.buf.slice(newline + 1);
      newline = this.buf.indexOf("\n");
      if (line.trim() === "") {
        continue;
      }
      let env: { id?: number; result?: unknown; error?: string; event?: unknown };
      try {
        env = JSON.parse(line) as typeof env;
      } catch {
        continue;
      }
      if (env.event !== undefined) {
        this.events += 1;
        this.eventBytes += line.length;
        continue;
      }
      const waiter = env.id === undefined ? undefined : this.pending.get(env.id);
      if (waiter === undefined) {
        continue;
      }
      this.pending.delete(env.id!);
      clearTimeout(waiter.timer);
      if (env.error !== undefined) {
        waiter.reject(new Error(env.error));
      } else {
        waiter.resolve(env.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
      this.pending.delete(id);
    }
  }
}

export function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key.slice(2)] = "1";
      } else {
        out[key.slice(2)] = next;
        index += 1;
      }
    }
  }
  return out;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

export function summarizeLatencies(samples: readonly number[]): { count: number; p50: number; p99: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? Number.NaN),
  };
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
