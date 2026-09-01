import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Client, Controller, openAttach } from "./controller.ts";
import { KindGeneral } from "./errors.ts";

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
