import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, type DevctlConfig } from "../../domain/config/types.ts";
import type { McpHost, WebListener } from "../../ports/web-host.ts";
import { WebCoordinator, type WebCoordinatorDeps } from "./web-coordinator.ts";

function tmpHome(): string {
  const dir = join(process.env.TMPDIR ?? "/tmp", `devctl-web-coord-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  process.env.DEVCTL_HOME = dir;
  return dir;
}

function fakeListener(opts: { host?: string; port: number }): WebListener {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    isRunning: () => true,
    listenPort: () => opts.port,
    address: () => `${opts.host ?? "127.0.0.1"}:${opts.port}`,
  };
}

function coordinator(cfg: DevctlConfig, extra: Partial<WebCoordinatorDeps> = {}) {
  const repo = tmpHome();
  return new WebCoordinator({
    repoRoot: () => repo,
    cfg: () => cfg,
    createListener: (opts) => fakeListener(opts),
    hostApi: () => ({}) as McpHost,
    log: () => undefined,
    ...extra,
  });
}

describe("web coordinator", () => {
  test("passes the configured listen host and a control token to the listener factory", async () => {
    const cfg = defaultConfig();
    cfg.web.enabled = true;
    cfg.web.listen.host = "127.0.0.2";
    cfg.web.listen.port = 18901;
    const logs: string[] = [];
    let captured: { host?: string; port: number; token: string } | undefined;
    const web = coordinator(cfg, {
      createListener: (opts) => {
        captured = { host: opts.host, port: opts.port, token: opts.token };
        return fakeListener(opts);
      },
      log: (_service, _level, message) => logs.push(message),
    });
    await web.start();
    expect(captured?.host).toBe("127.0.0.2");
    expect(captured?.port).toBe(18901);
    expect(captured?.token).toMatch(/^[0-9a-f]{48}$/);
    expect(web.address()).toBe("127.0.0.2:18901");
    expect(web.controlUrl()).toBe(`http://127.0.0.2:18901/#token=${captured?.token}`);
    expect(logs.join("\n")).toContain("web UI listening on http://127.0.0.2:18901/");
    expect(logs.join("\n")).not.toContain(captured?.token ?? "missing");
  });

  test("startExplicit reprints the same control URL while the listener is already up", async () => {
    const cfg = defaultConfig();
    cfg.web.enabled = true;
    cfg.web.listen.port = 18900;
    const web = coordinator(cfg);
    const first = await web.startExplicit();
    const second = await web.startExplicit();
    expect(first).toBe(second);
    expect(first).toContain("#token=");
  });

  test("sync starts when enabled and stops when disabled, without dropping an already-correct bind", async () => {
    const cfg = defaultConfig();
    cfg.web.enabled = false;
    cfg.web.listen.port = 18900;
    let starts = 0;
    let stops = 0;
    let running = false;
    const web = coordinator(cfg, {
      createListener: (opts) => ({
        start: async () => {
          starts += 1;
          running = true;
        },
        stop: async () => {
          stops += 1;
          running = false;
        },
        isRunning: () => running,
        listenPort: () => opts.port,
        address: () => `127.0.0.1:${opts.port}`,
      }),
    });
    await web.sync();
    expect(starts).toBe(0);
    cfg.web.enabled = true;
    await web.sync();
    expect(starts).toBe(1);
    await web.sync();
    expect(starts).toBe(1);
    cfg.web.enabled = false;
    await web.sync();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stops).toBe(1);
    expect(running).toBe(false);
  });

  test("stop then start reuses the persisted control token", async () => {
    const cfg = defaultConfig();
    cfg.web.enabled = true;
    cfg.web.listen.port = 18900;
    const web = coordinator(cfg);
    const first = await web.startExplicit();
    await web.stop();
    const second = await web.startExplicit();
    expect(second).toBe(first);
    expect(first).toContain("#token=");
  });
});
