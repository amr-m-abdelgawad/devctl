import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyService } from "../../domain/config/types.ts";
import { assignPorts, available, freePort, occupiedFixedPorts, parseFuser, parseLsof, parseNetstat, portBusyErrorFromHolder } from "./ports.ts";

// findPortHolder in a child process started with PATH=bin: Bun resolves
// executables from the PATH it started with, so changing process.env.PATH
// in this process would not reach stub (or missing) binaries.
function findPortHolderWithPath(bin: string, port: number): unknown {
  const script = `const { findPortHolder } = await import(${JSON.stringify(join(import.meta.dir, "ports.ts"))}); console.log(JSON.stringify((await findPortHolder(${port})) ?? null));`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: bin } });
  return JSON.parse(child.stdout.toString()) as unknown;
}

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

  test("parses Windows netstat listen rows by local address, not a foreign port", () => {
    const text = [
      "  TCP    127.0.0.1:54321        127.0.0.1:53220       ESTABLISHED     99",
      "  TCP    127.0.0.1:53220        0.0.0.0:0             LISTENING       1052",
      "  TCP    [::1]:53220            [::]:0                LISTENING       1052",
    ].join("\n");
    expect(parseNetstat(text, 53220)).toEqual({ port: 53220, pid: 1052, command: "process" });
    expect(parseNetstat(text, 54321)).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("findPortHolder degrades to undefined when lsof/fuser are missing from $PATH", async () => {
    const empty = mkdtempSync(join(tmpdir(), "devctl-nobin-"));
    try {
      expect(findPortHolderWithPath(empty, 18081)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("the fuser fallback never reports the port number as the holder pid", async () => {
    // lsof finds nothing; fuser prints only its "<port>/tcp:" label (on stderr),
    // as it does when the holder belongs to another user, or an error such as
    // macOS fuser's usage text.
    const dirs: string[] = [];
    const withFuser = (fuser: string): unknown => {
      const bin = mkdtempSync(join(tmpdir(), "devctl-fuser-"));
      dirs.push(bin);
      for (const [name, body] of [["lsof", "exit 1"], ["fuser", fuser]] as const) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      }
      return findPortHolderWithPath(bin, 18082);
    };
    try {
      expect(withFuser('echo "18082/tcp:" >&2')).toBeNull();
      expect(withFuser('echo "fuser: illegal option -- n" >&2; echo "usage: fuser [-cfu] file ..." >&2; exit 1')).toBeNull();
      // psmisc: pids on stdout, the label on stderr.
      expect(withFuser('echo "18082/tcp:" >&2; echo "   4321  4400"')).toEqual({ port: 18082, pid: 4321, command: "process" });
    } finally {
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("parseFuser reads pids from fuser's stdout only", () => {
    expect(parseFuser("   685\n", 18779)).toBe(685);
    expect(parseFuser(" 685 700\n", 18779)).toBe(685);
    expect(parseFuser("18779/tcp:   685\n", 18779)).toBe(685);
    expect(parseFuser("", 18779)).toBeUndefined();
    expect(parseFuser("18779/tcp:\n", 18779)).toBeUndefined();
    // A pid equal to the port is still a pid once the label is gone.
    expect(parseFuser("18779\n", 18779)).toBe(18779);
    expect(parseFuser("18779/tcp:  18779\n", 18779)).toBe(18779);
    expect(parseFuser("0\n", 18779)).toBeUndefined();
  });

  describe("freePort re-checks the holder before each signal", () => {
    const holder = { port: 18090, pid: 4242, command: "node" };
    function harness(lookups: Array<{ port: number; pid: number; command: string } | undefined>) {
      const signals: Array<[number, string]> = [];
      const queue = [...lookups];
      return {
        signals,
        deps: {
          lookup: async () => queue.shift(),
          kill: (pid: number, signal: NodeJS.Signals) => {
            signals.push([pid, signal]);
          },
          waitMs: 0,
        },
      };
    }

    test("a port now held by another pid is left alone", async () => {
      const h = harness([{ port: 18090, pid: 5151, command: "python3" }]);
      await expect(freePort(holder, h.deps)).rejects.toThrow("port 18090 is now held by python3 (pid 5151), not pid 4242; not stopping it");
      expect(h.signals).toEqual([]);
    });

    test("a port nobody holds any more is reported as already free", async () => {
      const h = harness([undefined]);
      expect(await freePort(holder, h.deps)).toBe("already-free");
      expect(h.signals).toEqual([]);
    });

    test("no SIGKILL once SIGTERM released the port", async () => {
      const h = harness([holder, undefined]);
      expect(await freePort(holder, h.deps)).toBe("stopped");
      expect(h.signals).toEqual([[4242, "SIGTERM"]]);
    });

    test("no SIGKILL when a different pid holds the port after SIGTERM", async () => {
      const h = harness([holder, { port: 18090, pid: 6161, command: "other" }]);
      expect(await freePort(holder, h.deps)).toBe("stopped");
      expect(h.signals).toEqual([[4242, "SIGTERM"]]);
    });

    test("SIGKILL when the same pid still holds the port", async () => {
      const h = harness([holder, holder]);
      expect(await freePort(holder, h.deps)).toBe("stopped");
      expect(h.signals).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    });

    test("refuses to stop this process", async () => {
      const h = harness([]);
      await expect(freePort({ ...holder, pid: process.pid }, h.deps)).rejects.toThrow("held by this TUI");
      expect(h.signals).toEqual([]);
    });
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

  test("an invalid port is attributed to the service that declared it", async () => {
    const cfg = defaultConfig();
    cfg.services.api = { ...emptyService(), ports: [{ name: "http", value: 0, auto: false }] };
    await expect(assignPorts(cfg, ["api"])).rejects.toMatchObject({ service: "api" });
  });

  test("auto ports chosen together stay distinct and free to bind", async () => {
    const cfg = defaultConfig();
    for (const name of ["web", "rpc", "raw"]) {
      cfg.services[name] = {
        ...emptyService(),
        ports: [{ name: "http", value: 0, auto: true }],
      };
    }
    const assigned = await assignPorts(cfg, ["web", "rpc", "raw"]);
    const ports = ["web", "rpc", "raw"].map((name) => assigned[name]?.http ?? 0);
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) {
      expect(await available(port)).toBe(true);
    }
  });

  test("a duplicate port is attributed to the service whose assignment actually collides, not an unrelated one", async () => {
    const cfg = defaultConfig();
    cfg.services.a = { ...emptyService(), ports: [{ name: "http", value: 19_999, auto: false }] };
    cfg.services.b = { ...emptyService(), ports: [{ name: "http", value: 19_999, auto: false }] };
    // a claims 19999 first (no conflict yet); b is the one whose assignment
    // discovers the collision — it must be blamed, not a.
    await expect(assignPorts(cfg, ["a", "b"])).rejects.toMatchObject({ service: "b" });
  });
});
