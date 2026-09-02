import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Client, Controller, ensureSupervisor, openAttach, supervisorSpawnCommand } from "./controller.ts";
import { KindGeneral } from "./errors.ts";
import { bootstrapLogPath } from "./storage.ts";

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
