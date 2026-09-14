import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import type { McpHost, WebListener } from "../../ports/web-host.ts";
import { WebCoordinator } from "./web-coordinator.ts";

function fakeListener(opts: { host?: string; port: number }): WebListener {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    isRunning: () => true,
    listenPort: () => opts.port,
    address: () => `${opts.host ?? "127.0.0.1"}:${opts.port}`,
  };
}

describe("web coordinator", () => {
  test("passes the configured listen host and a control token to the listener factory", async () => {
    const cfg = defaultConfig();
    cfg.web.enabled = true;
    cfg.web.listen.host = "127.0.0.2";
    cfg.web.listen.port = 18901;
    const logs: string[] = [];
    let captured: { host?: string; port: number; token: string } | undefined;
    const web = new WebCoordinator({
      cfg: () => cfg,
      createListener: (opts) => {
        captured = { host: opts.host, port: opts.port, token: opts.token };
        return fakeListener(opts);
      },
      hostApi: () => ({}) as McpHost,
      log: (_service, _level, message) => logs.push(message),
    });
    await web.start();
    expect(captured?.host).toBe("127.0.0.2");
    expect(captured?.port).toBe(18901);
    expect(captured?.token).toMatch(/^[0-9a-f]{48}$/);
    expect(web.address()).toBe("127.0.0.2:18901");
    expect(web.controlUrl()).toBe(`http://127.0.0.2:18901/?token=${captured?.token}`);
    expect(logs.join("\n")).toContain("web UI listening on http://127.0.0.2:18901/");
    expect(logs.join("\n")).not.toContain(captured?.token ?? "missing");
  });

  test("startExplicit reprints the same control URL while the listener is already up", async () => {
    const cfg = defaultConfig();
    cfg.web.enabled = true;
    cfg.web.listen.port = 18900;
    const web = new WebCoordinator({
      cfg: () => cfg,
      createListener: (opts) => fakeListener(opts),
      hostApi: () => ({}) as McpHost,
      log: () => undefined,
    });
    const first = await web.startExplicit();
    const second = await web.startExplicit();
    expect(first).toBe(second);
    expect(first).toContain("?token=");
  });
});
