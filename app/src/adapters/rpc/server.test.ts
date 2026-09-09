import { connect, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Bus } from "../../shared/events.ts";
import { KindGeneral, newError } from "../../shared/errors.ts";
import { socketPath } from "../storage/storage.ts";
import { RpcServer } from "./server.ts";

function tmp(): string {
  const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = join(dir, "home");
  return dir;
}

function rpcCall(socket: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = connect(socket);
    let buf = "";
    conn.on("connect", () => {
      conn.write(`${JSON.stringify(payload)}\n`);
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        conn.end();
        resolve(JSON.parse(line));
      }
    });
    conn.on("error", reject);
  });
}

describe("rpc server", () => {
  test("frames requests, returns results, and serializes dispatch errors", async () => {
    const dir = tmp();
    const path = socketPath(dir);
    const server = new RpcServer({
      dispatch: async (method, params) => {
        if (method === "ping") {
          return { ok: true, params };
        }
        throw newError(KindGeneral, `unknown method ${method}`);
      },
      subscribe: (handler) => new Bus(16).subscribe(handler),
      log: () => undefined,
      socketExists: existsSync,
      unlinkSocket: unlinkSync,
    });
    try {
      await server.listen(path);
      const ok = await rpcCall(path, { id: 1, method: "ping", params: { services: ["api"] } }) as {
        id: number;
        result: { ok: boolean; params: { services: string[] } };
      };
      expect(ok.id).toBe(1);
      expect(ok.result.ok).toBe(true);
      expect(ok.result.params.services).toEqual(["api"]);

      const bad = await rpcCall(path, { id: 2, method: "nope" }) as { id: number; error: string; kind: string };
      expect(bad.id).toBe(2);
      expect(bad.error).toMatch(/unknown method nope/);
      expect(bad.kind).toBe(KindGeneral);

      const invalid = await new Promise<unknown>((resolve, reject) => {
        const conn = connect(path);
        let buf = "";
        conn.on("connect", () => conn.write("not-json\n"));
        conn.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() === "") {
              continue;
            }
            conn.end();
            resolve(JSON.parse(line));
          }
        });
        conn.on("error", reject);
      }) as { error: string };
      expect(invalid.error).toBe("invalid json");
    } finally {
      server.close();
    }
  });

  test("an error on an accepted client socket is handled, not thrown", async () => {
    const dir = tmp();
    const path = socketPath(dir);
    const server = new RpcServer({
      dispatch: async () => null,
      subscribe: (handler) => new Bus(16).subscribe(handler),
      log: () => undefined,
      socketExists: existsSync,
      unlinkSocket: unlinkSync,
    });
    let client: Socket | undefined;
    try {
      await server.listen(path);
      const native = server.nativeServer;
      expect(native).toBeDefined();
      let captured: Socket | undefined;
      native?.on("connection", (s) => {
        captured = s;
      });
      client = connect(path);
      await new Promise<void>((resolve, reject) => {
        client?.once("connect", () => resolve());
        client?.once("error", reject);
      });
      const deadline = Date.now() + 2000;
      while (captured === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(() => captured?.emit("error", new Error("ECONNRESET (simulated)"))).not.toThrow();
    } finally {
      client?.destroy();
      server.close();
    }
  });

  test("removeStaleSocket unlinks an existing unix socket", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tmp();
    const path = join(dir, "stale.sock");
    writeFileSync(path, "");
    let unlinked = false;
    const server = new RpcServer({
      dispatch: async () => null,
      subscribe: (handler) => new Bus(16).subscribe(handler),
      log: () => undefined,
      socketExists: existsSync,
      unlinkSocket: (socket) => {
        unlinked = socket === path;
        unlinkSync(socket);
      },
    });
    server.removeStaleSocket(path);
    expect(unlinked).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
