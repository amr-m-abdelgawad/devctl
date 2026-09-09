import { createServer, type Server, type Socket } from "node:net";
import type { Bus } from "../../shared/events.ts";
import { humanMessage, serializeError } from "../../shared/errors.ts";
import type { Envelope } from "../../types.ts";

export type RpcDispatch = (method: string, params: unknown) => Promise<unknown>;

export type RpcServerDeps = {
  dispatch: RpcDispatch;
  subscribe: Bus["subscribe"];
  log: (service: string, level: string, message: string) => void;
  socketExists: (socket: string) => boolean;
  unlinkSocket: (socket: string) => void;
};

const MAX_QUEUED_EVENTS = 2000;

export class RpcServer {
  private server?: Server;
  private readonly deps: RpcServerDeps;

  constructor(deps: RpcServerDeps) {
    this.deps = deps;
  }

  get nativeServer(): Server | undefined {
    return this.server;
  }

  removeStaleSocket(socket: string): void {
    // Windows named pipes are not filesystem entries and vanish with the
    // process that held them; existsSync/unlinkSync do not apply.
    if (process.platform === "win32") {
      return;
    }
    if (this.deps.socketExists(socket)) {
      try {
        this.deps.unlinkSocket(socket);
      } catch {
        this.deps.log("devctl", "WARN", "unable to remove stale socket");
      }
    }
  }

  listen(socket: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((socketConn) => {
        this.handleConn(socketConn);
      });
      this.server.on("error", reject);
      this.server.listen(socket, () => resolve());
    });
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
  }

  private handleConn(socketConn: Socket): void {
    let buf = "";
    // Bound the outgoing queue so a slow reader under a high-frequency log
    // stream can't grow memory without limit. Only pure event pushes (no
    // `id`) are droppable — an RPC response always carries an `id` and the
    // client would hang forever waiting for it, so those are never dropped.
    const queue: Envelope[] = [];
    let waitingForDrain = false;
    const pump = (): void => {
      while (queue.length > 0) {
        const env = queue[0];
        const ok = socketConn.write(`${JSON.stringify(env)}\n`);
        queue.shift();
        if (!ok) {
          waitingForDrain = true;
          socketConn.once("drain", () => {
            waitingForDrain = false;
            pump();
          });
          return;
        }
      }
    };
    const write = (env: Envelope): void => {
      const droppable = env.id === undefined && env.event !== undefined;
      if (droppable && queue.length >= MAX_QUEUED_EVENTS) {
        // Evict the oldest droppable entry specifically — not index 0, which
        // may be an RPC response the client is blocked waiting on. If the
        // queue is entirely RPC responses, let it grow; that's fine, RPCs
        // aren't the high-frequency case this cap exists for.
        const i = queue.findIndex((e) => e.id === undefined && e.event !== undefined);
        if (i >= 0) {
          queue.splice(i, 1);
        }
      }
      queue.push(env);
      if (!waitingForDrain) {
        pump();
      }
    };
    const unsub = this.deps.subscribe((event) => write({ event }));
    // Without a listener here, Node's default behavior for an unhandled
    // socket 'error' (ECONNRESET/EPIPE from a client that disconnected
    // abruptly — killed, crashed, network blip — mid-write) is to throw,
    // crashing the whole daemon and every other attached client and
    // running service along with it. This is an ordinary disconnect, not a
    // supervisor fault: log it and let the "close" handler below do its
    // usual cleanup.
    socketConn.on("error", (err) => {
      this.deps.log("devctl", "WARN", `client connection error: ${humanMessage(err)}`);
    });
    socketConn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        void this.dispatchLine(line, write);
      }
    });
    socketConn.on("close", () => unsub());
  }

  private async dispatchLine(line: string, write: (env: Envelope) => void): Promise<void> {
    let env: Envelope;
    try {
      env = JSON.parse(line) as Envelope;
    } catch {
      write({ error: "invalid json" });
      return;
    }
    try {
      const result = await this.deps.dispatch(env.method ?? "", env.params);
      write({ id: env.id, result });
    } catch (err) {
      const serialized = serializeError(err);
      write({ id: env.id, error: serialized.error, kind: serialized.kind, hint: serialized.hint, service: serialized.service });
    }
  }
}
