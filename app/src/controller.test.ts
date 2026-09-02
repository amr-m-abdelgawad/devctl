import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Client, Controller, dial, ensureSupervisor, findDaemon, openAttach, openTui, supervisorSpawnCommand } from "./controller.ts";
import { osEnviron } from "./environment.ts";
import { KindConfiguration, KindConfigurationMissing, KindGeneral } from "./errors.ts";
import { bootstrapLogPath, socketPath } from "./storage.ts";
import { RPC_PROTOCOL_VERSION, VERSION } from "./version.ts";

function tmp(): string {
  const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-handshake-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = join(dir, "home");
  return dir;
}

// A minimal fake supervisor that answers "ping" with a fixed payload and
// nothing else — enough to test how the client interprets a handshake
// response without spinning up a real Supervisor.
function fakePingServer(repoRoot: string, pingResult: unknown): { close: () => Promise<void> } {
  const path = socketPath(repoRoot);
  const server = createServer((conn: Socket) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        const env = JSON.parse(line) as { id?: string; method?: string };
        if (env.method === "ping") {
          conn.write(`${JSON.stringify({ id: env.id, result: pingResult })}\n`);
        }
      }
    });
  });
  server.listen(path);
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("RPC client", () => {
  test("closing the socket rejects pending calls instead of keeping the process alive", async () => {
    const socket = new EventEmitter() as EventEmitter & { write: () => boolean; destroy: () => void };
    socket.write = () => true;
    socket.destroy = () => socket.emit("close");
    const client = new Client(socket as never);
    const pending = client.call("shutdown", {}, 1_000);
    const outcome = pending.then(
      () => "resolved",
      (err: unknown) => err instanceof Error ? err.message : String(err),
    );
    client.close();
    expect(await outcome).toContain("supervisor connection closed");
  });

  test("Controller.refreshAuth calls the daemon probe rather than refreshing only local CLI state", async () => {
    const calls: string[] = [];
    const identity = {
      user: "dev@example.com",
      project: "demo",
      project_source: "configuration",
      adc: true,
      service_accounts: { "worker@example.com": true },
      service_account_status: { "worker@example.com": "available" as const },
      iap: true,
    };
    const ctrl = new Controller({ shutdown: {} } as never);
    ctrl.client = {
      compat: { compatible: true, legacy: false },
      call: async (method: string) => {
        calls.push(method);
        return identity;
      },
      close: () => undefined,
    } as unknown as Client;

    expect(await ctrl.refreshAuth()).toEqual(identity);
    expect(calls).toEqual(["auth_refresh"]);
  });
});

describe("supervisor spawn command", () => {
  test("source mode passes the script path so Bun knows what to run", () => {
    expect(supervisorSpawnCommand("/root/.bun/bin/bun", "/repo/app/src/bin.ts", false, ["_supervisor", "--repo", "/repo"])).toEqual([
      "/root/.bun/bin/bun",
      "/repo/app/src/bin.ts",
      "_supervisor",
      "--repo",
      "/repo",
    ]);
  });

  test("compiled-binary mode omits the virtual script argument", () => {
    // A compiled executable's argv[1] is the caller's own first CLI argument
    // (e.g. "status"), not a script path — including it would make the child
    // parse "status _supervisor --repo /repo" as its own command line.
    expect(supervisorSpawnCommand("/usr/local/bin/devctl", "status", true, ["_supervisor", "--repo", "/repo"])).toEqual([
      "/usr/local/bin/devctl",
      "_supervisor",
      "--repo",
      "/repo",
    ]);
  });
});

describe("ensureSupervisor bootstrap failure", () => {
  test("reports the bootstrap log path when the supervisor never comes up", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-bootstrap-fail-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    process.env.DEVCTL_HOME = join(dir, "home");
    // No .devctl/config.yaml exists at this path, so the real spawned
    // `_supervisor` process fails to load configuration and exits almost
    // immediately instead of ever binding a socket — exercising the real
    // dial-timeout-then-report path end to end, not a mocked one.
    const configPath = join(dir, ".devctl", "config.yaml");
    const originalArgv1 = process.argv[1] ?? "";
    process.argv[1] = join(import.meta.dir, "bin.ts");
    try {
      await expect(ensureSupervisor(dir, configPath)).rejects.toMatchObject({
        kind: KindGeneral,
        hint: `see ${bootstrapLogPath(dir)} for details`,
      });
      expect(readFileSync(bootstrapLogPath(dir), "utf8").length).toBeGreaterThan(0);
    } finally {
      process.argv[1] = originalArgv1;
    }
  }, 15_000);
});

describe("daemon compatibility handshake", () => {
  test("dial marks a same-protocol daemon compatible and captures its session/version", async () => {
    const dir = tmp();
    const fake = fakePingServer(dir, { session: "sess-123", version: "9.9.9", protocol: RPC_PROTOCOL_VERSION });
    try {
      const client = await dial(dir, 2_000);
      expect(client.compat).toEqual({ compatible: true, legacy: false, daemonVersion: "9.9.9", daemonProtocol: RPC_PROTOCOL_VERSION });
      expect(client.session).toBe("sess-123");
      client.close();
    } finally {
      await fake.close();
    }
  });

  test("dial marks a pre-handshake (legacy) daemon incompatible", async () => {
    const dir = tmp();
    // No `protocol` field at all — exactly what a Release 1 daemon's ping
    // response looks like.
    const fake = fakePingServer(dir, { session: "sess-legacy" });
    try {
      const client = await dial(dir, 2_000);
      expect(client.compat).toEqual({ compatible: false, legacy: true, daemonVersion: undefined });
      client.close();
    } finally {
      await fake.close();
    }
  });

  test("dial marks a mismatched-protocol daemon incompatible without calling it legacy", async () => {
    const dir = tmp();
    const fake = fakePingServer(dir, { session: "sess-future", version: "9.9.9", protocol: RPC_PROTOCOL_VERSION + 1 });
    try {
      const client = await dial(dir, 2_000);
      expect(client.compat).toEqual({
        compatible: false,
        legacy: false,
        daemonVersion: "9.9.9",
        daemonProtocol: RPC_PROTOCOL_VERSION + 1,
      });
      client.close();
    } finally {
      await fake.close();
    }
  });

  test("Controller.call blocks ordinary methods but not logs against an incompatible daemon", async () => {
    const calls: string[] = [];
    const fakeClient = {
      compat: { compatible: false, legacy: true },
      call: async (method: string) => {
        calls.push(method);
        return { events: [] };
      },
      close: () => undefined,
    };
    const ctrl = new Controller({ shutdown: {} } as never);
    ctrl.client = fakeClient as unknown as Client;

    await expect(ctrl.stop([])).rejects.toMatchObject({ kind: KindGeneral });
    await expect(ctrl.logs({})).resolves.toEqual([]);
    expect(calls).toEqual(["logs"]);
  });

  test("a real supervisor's ping reports the current binary version and protocol", async () => {
    const dir = tmp();
    const cfg = (await import("./config/types.ts")).defaultConfig();
    cfg.repoRoot = dir;
    cfg.logs.persistence.enabled = false;
    const { Supervisor } = await import("./supervisor.ts");
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      const client = await dial(dir, 2_000);
      expect(client.compat.compatible).toBe(true);
      expect(client.compat.daemonProtocol).toBe(RPC_PROTOCOL_VERSION);
      expect(client.compat.daemonVersion).toBe(VERSION);
      client.close();
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);
});

describe("findDaemon", () => {
  test("locates a live daemon via the state-scan fallback after .devctl is deleted", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(join(dir, ".devctl", "config.yaml"), "version: 1\nservices:\n  api:\n    command: [echo, ok]\n");
    const { load } = await import("./config/index.ts");
    const cfg = load(dir, "");
    cfg.logs.persistence.enabled = false;
    const { Supervisor } = await import("./supervisor.ts");
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      // The whole point: the configuration this daemon was started with no
      // longer exists, yet the daemon itself is still running.
      rmSync(join(dir, ".devctl"), { recursive: true, force: true });
      const { repoRoot, client } = await findDaemon(dir, "");
      expect(repoRoot).toBe(dir);
      expect(client).toBeDefined();
      client?.close();
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);

  test("throws a clear error when neither discovery nor a daemon can be found", async () => {
    const dir = tmp();
    await expect(findDaemon(dir, "")).rejects.toThrow(/no devctl configuration found/);
  });
});

describe("openTui", () => {
  test("attaches to a live daemon even when the on-disk config is now invalid", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(
      join(dir, ".devctl", "config.yaml"),
      `version: 1
project:
  name: was-valid
services:
  api:
    command: [echo, ok]
`,
    );
    const { load } = await import("./config/index.ts");
    const cfg = load(dir, "");
    cfg.logs.persistence.enabled = false;
    const { Supervisor } = await import("./supervisor.ts");
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      // The file is still there (discovery still finds it), but its
      // contents are now garbage — a plain load() would throw. The daemon
      // started from the last-good version of it is still live, and must
      // still be fully attachable, sourcing its config from the snapshot.
      writeFileSync(join(dir, ".devctl", "config.yaml"), "version: [\n");
      const ctrl = await openTui(dir, "");
      try {
        expect(ctrl.client).toBeDefined();
        expect(ctrl.cfg.project.name).toBe("was-valid");
      } finally {
        ctrl.client?.close();
      }
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);

  test("throws KindConfigurationMissing when there is no daemon and no config anywhere", async () => {
    const dir = tmp();
    await expect(openTui(dir, "")).rejects.toMatchObject({ kind: KindConfigurationMissing });
  });

  test("throws a real configuration error, not KindConfigurationMissing, when there is no daemon and the config is invalid", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(join(dir, ".devctl", "config.yaml"), "version: [\n");
    await expect(openTui(dir, "")).rejects.toMatchObject({ kind: KindConfiguration });
  });

  test("spawns a fresh daemon when none exists and the config is valid, sourcing cfg from its snapshot", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(
      join(dir, ".devctl", "config.yaml"),
      `version: 1
project:
  name: fresh-daemon
services:
  api:
    command: [echo, ok]
`,
    );
    const originalArgv1 = process.argv[1] ?? "";
    process.argv[1] = join(import.meta.dir, "bin.ts");
    try {
      const ctrl = await openTui(dir, "");
      try {
        expect(ctrl.client).toBeDefined();
        expect(ctrl.cfg.project.name).toBe("fresh-daemon");
      } finally {
        await ctrl.close({ shutdownSupervisor: true });
      }
    } finally {
      process.argv[1] = originalArgv1;
    }
  }, 15_000);
});

describe("attach", () => {
  test("openAttach does not spawn a supervisor when none is running", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/devctl-attach-${Date.now()}`;
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    process.env.DEVCTL_HOME = join(dir, "home");
    writeFileSync(
      join(dir, ".devctl", "config.yaml"),
      `version: 1
project:
  name: attach-test
services:
  api:
    command: [echo, ok]
`,
    );
    await expect(openAttach(dir, "")).rejects.toMatchObject({ kind: KindGeneral });
  });

  test("openAttach attaches even when the on-disk config is now invalid, sourcing cfg from the daemon's snapshot", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".devctl"), { recursive: true });
    writeFileSync(
      join(dir, ".devctl", "config.yaml"),
      `version: 1
project:
  name: attach-was-valid
services:
  api:
    command: [echo, ok]
`,
    );
    const { load } = await import("./config/index.ts");
    const cfg = load(dir, "");
    cfg.logs.persistence.enabled = false;
    const { Supervisor } = await import("./supervisor.ts");
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" }),
    });
    try {
      await sup.run();
      writeFileSync(join(dir, ".devctl", "config.yaml"), "version: [\n");
      const ctrl = await openAttach(dir, "");
      try {
        expect(ctrl.cfg.project.name).toBe("attach-was-valid");
      } finally {
        ctrl.client?.close();
      }
    } finally {
      await sup.shutdown(false);
    }
  }, 15_000);
});

describe("controller close", () => {
  test("TUI-owned close asks an attached supervisor to stop services", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let closed = false;
    const ctrl = new Controller({ shutdown: { stop_services_on_exit: true } } as never);
    ctrl.client = {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return null;
      },
      close: () => {
        closed = true;
      },
    } as never;

    await ctrl.close({ shutdownSupervisor: true });

    expect(calls).toEqual([{ method: "shutdown", params: { stop_services: true } }]);
    expect(closed).toBe(true);
  });

  test("detach and ordinary command cleanup only close the client", async () => {
    for (const opts of [{ shutdownSupervisor: true, detach: true }, undefined]) {
      const calls: string[] = [];
      const ctrl = new Controller({ shutdown: { stop_services_on_exit: true } } as never);
      ctrl.client = {
        call: async (method: string) => {
          calls.push(method);
          return null;
        },
        close: () => undefined,
      } as never;
      await ctrl.close(opts);
      expect(calls).toEqual([]);
    }
  });
});

describe("client_env forwarding", () => {
  test("Controller.start and Controller.restart forward the calling client's own process.env", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const ctrl = new Controller({ shutdown: {} } as never);
    ctrl.client = {
      compat: { compatible: true, legacy: false },
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return null;
      },
      close: () => undefined,
    } as never;

    await ctrl.start({ services: ["api"] });
    await ctrl.restart(["api"]);

    expect(calls).toEqual([
      { method: "start", params: { services: ["api"], client_env: osEnviron() } },
      { method: "restart", params: { services: ["api"], cascade: false, client_env: osEnviron() } },
    ]);
  });
});
