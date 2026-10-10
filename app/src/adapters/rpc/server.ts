import { createServer, type Server, type Socket } from "node:net";
import { LogBatch, LogReceived, type Bus } from "../../shared/events.ts";
import { humanMessage, serializeError } from "../../shared/errors.ts";
import type { Envelope } from "../../types.ts";
import { KindAuthorization } from "../../shared/errors.ts";
import { secretMatches } from "../../shared/bearer.ts";
import { OutboundQueue } from "./outbound-queue.ts";

export type RpcDispatch = (method: string, params: unknown) => Promise<unknown>;

export type RpcServerDeps = {
  dispatch: RpcDispatch;
  subscribe: Bus["subscribe"];
  log: (service: string, level: string, message: string) => void;
  socketExists: (socket: string) => boolean;
  unlinkSocket: (socket: string) => void;
  token: string;
};

// Cap the inbound line buffer so a local peer cannot grow supervisor memory
// without bound by streaming bytes with no newline — the buffer accumulates
// before any token check, since auth runs per complete line in dispatchLine.
// Matches the MCP body cap (1 MiB); RPC frames are small control messages.
const MAX_BUFFER_BYTES = 1024 * 1024;

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
    let authed = false;
    let unsub = (): void => undefined;
    // The outgoing queue stays bounded while a client is slow or suspended:
    // live log batches merge, legacy per-record events drop their oldest,
    // and responses (which a client waits on by `id`) are never dropped.
    const queue = new OutboundQueue();
    let waitingForDrain = false;
    let closed = false;
    let logBatch = false;
    const pump = (): void => {
      while (!waitingForDrain && !closed) {
        const envs = queue.drain(COALESCE_LINES);
        if (envs.length === 0) {
          return;
        }
        let lines = "";
        for (const env of envs) {
          lines += `${JSON.stringify(env)}\n`;
        }
        const ok = socketConn.write(lines);
        if (!ok) {
          waitingForDrain = true;
          socketConn.once("drain", () => {
            waitingForDrain = false;
            setImmediate(pump);
          });
        }
      }
    };
    const write = (env: Envelope): void => {
      if (closed) {
        return;
      }
      const eventType = eventTypeOf(env);
      if (logBatch && eventType === LogReceived) {
        return;
      }
      if (!logBatch && eventType === LogBatch) {
        return;
      }
      if (!queue.push(env)) {
        this.deps.log("devctl", "WARN", "client stopped reading replies; closing its connection");
        closed = true;
        queue.clear();
        socketConn.destroy();
        return;
      }
      if (!waitingForDrain) {
        pump();
      }
    };
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
      // Measure the pending buffer in UTF-8 bytes, not UTF-16 code units, so a
      // newline-free stream of multibyte characters can't retain ~2x the cap
      // before this fires.
      if (Buffer.byteLength(buf, "utf8") > MAX_BUFFER_BYTES) {
        this.deps.log("devctl", "WARN", "client connection exceeded max buffer; closing");
        buf = "";
        socketConn.destroy();
        return;
      }
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") {
          void this.dispatchLine(line, write, () => {
            if (!authed) {
              unsub = this.deps.subscribe((event) => write({ event }));
              authed = true;
            }
          }, (features) => {
            logBatch = features.includes("log_batch.v1");
          });
        }
      }
    });
    socketConn.on("close", () => {
      closed = true;
      queue.clear();
      unsub();
    });
  }

  private async dispatchLine(
    line: string,
    write: (env: Envelope) => void,
    onAuthed: () => void,
    noteFeatures: (features: string[]) => void,
  ): Promise<void> {
    let env: Envelope;
    try {
      env = JSON.parse(line) as Envelope;
    } catch {
      write({ error: "invalid json" });
      return;
    }
    if (!secretMatches(env.auth ?? "", this.deps.token)) {
      write({ id: env.id, error: "unauthorized", kind: KindAuthorization });
      return;
    }
    if (env.method === "ping") {
      noteFeatures(featureList(env.params));
    }
    onAuthed();
    try {
      const result = await this.deps.dispatch(env.method ?? "", env.params);
      write({ id: env.id, result });
    } catch (err) {
      const serialized = serializeError(err);
      write({ id: env.id, error: serialized.error, kind: serialized.kind, hint: serialized.hint, service: serialized.service });
    }
  }
}

const COALESCE_LINES = 32;

function eventTypeOf(env: Envelope): string | undefined {
  const event = env.event as { type?: unknown } | undefined;
  return typeof event?.type === "string" ? event.type : undefined;
}

function featureList(params: unknown): string[] {
  if (typeof params !== "object" || params === null) {
    return [];
  }
  const features = (params as { features?: unknown }).features;
  if (!Array.isArray(features)) {
    return [];
  }
  return features.filter((item): item is string => typeof item === "string");
}
