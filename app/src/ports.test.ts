import { createServer } from "node:net";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "./config/types.ts";
import { assignPorts, occupiedFixedPorts, parseLsof, portBusyErrorFromHolder } from "./ports.ts";

function listen(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        server.close();
        reject(new Error("no address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
    server.on("error", reject);
  });
}

describe("port holders", () => {
  test("parses lsof listen rows", () => {
    const text = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    12345 amr   23u  IPv4 0x0      0t0  TCP 127.0.0.1:18000 (LISTEN)
`;
    expect(parseLsof(text, 18000)).toEqual({ port: 18000, pid: 12345, command: "node" });
  });

  test("port busy copy names the holder and what to change", () => {
    const err = portBusyErrorFromHolder("api", "http", 18000, { port: 18000, pid: 12345, command: "python3" });
    expect(err.service).toBe("api");
    expect(err.message).toContain("api blocked: python3 (pid 12345) is using port 18000");
    expect(err.hint).toContain("Doctor");
    expect(err.hint).toContain("api ports.http");
  });

  test("returns nothing when lsof is empty", () => {
    expect(parseLsof("COMMAND   PID USER\n", 18080)).toBeUndefined();
  });

  test("occupiedFixedPorts reports when every fixed port is taken", async () => {
    const held = await listen();
    const svc = { ports: [{ name: "http", value: held.port, auto: false }] };
    try {
      expect(await occupiedFixedPorts(svc)).toEqual({ http: held.port });
    } finally {
      await held.close();
    }
    expect(await occupiedFixedPorts(svc)).toBeUndefined();
  });

  test("reuses a port already assigned to the same service", async () => {
    const held = await listen();
    const cfg = defaultConfig();
    cfg.services.auth = {
      ...emptyService(),
      ports: [{ name: "http", value: held.port, auto: false }],
    };
    try {
      await expect(assignPorts(cfg, ["auth"])).rejects.toThrow(/auth blocked:.*port/);
      const next = await assignPorts(cfg, ["auth"], { auth: { http: held.port } });
      expect(next.auth?.http).toBe(held.port);
    } finally {
      await held.close();
    }
  });
});
