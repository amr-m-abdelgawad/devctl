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
  test("passes the configured listen host to the listener factory", async () => {
    const cfg = defaultConfig();
    cfg.web.enabled = true;
    cfg.web.listen.host = "127.0.0.2";
    cfg.web.listen.port = 18901;
    let captured: { host?: string; port: number } | undefined;
    const web = new WebCoordinator({
      cfg: () => cfg,
      createListener: (opts) => {
        captured = { host: opts.host, port: opts.port };
        return fakeListener(opts);
      },
      hostApi: () => ({}) as McpHost,
      log: () => undefined,
    });
    await web.start();
    expect(captured).toEqual({ host: "127.0.0.2", port: 18901 });
    expect(web.address()).toBe("127.0.0.2:18901");
  });
});
