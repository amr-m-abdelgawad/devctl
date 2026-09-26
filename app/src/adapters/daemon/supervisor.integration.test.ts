import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { load } from "../config/index.ts";
import { Supervisor } from "../../bootstrap/test-supervisor.ts";

function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

describe("demo-platform integration", () => {
  // Bun 1.4.2 on Windows can segfault while spawning this demo service
  // (main CI after #95). The same hop is covered on Linux.
  test.skipIf(process.platform === "win32")("starts and stops the Python identity service without Google", async () => {
    const home = join(tmpdir(), `devctl-int-${Date.now()}`);
    mkdirSync(home, { recursive: true });
    process.env.DEVCTL_HOME = home;
    const root = resolve(import.meta.dir, "../../../../examples/demo-platform");
    const cfg = load(root, "");
    cfg.logs.persistence.enabled = false;
    cfg.proxy.enabled = false;
    for (const svc of Object.values(cfg.services)) {
      svc.identity = { type: "", mode: "", service_account: "" };
    }
    // The demo pins identity to 18001, which a locally running demo already
    // holds; move it to a free port so the test doesn't depend on that.
    const identity = cfg.services.identity!;
    const port = await unusedPort();
    identity.ports = identity.ports.map((p) => (p.name === "http" ? { ...p, value: port } : p));
    identity.health.url = identity.health.url.replace(":18001", `:${port}`);
    const sup = new Supervisor(cfg, {
      detectGoogle: async () => ({
        gcloudInstalled: false,
        adcAvailable: false,
        userEmail: "",
        projectID: cfg.google.project_id,
        projectSource: "configuration",
      }),
    });
    try {
      const plan = await sup.start({ services: ["identity"] }).catch(async (err: unknown) => {
        // Say why identity never came up (its output, health, last error);
        // the bare "failed to start" hides it, e.g. on the macOS runner.
        const rt = sup.snapshot().services.identity;
        const { events } = (await sup.dispatch("logs", {})) as { events: Array<{ service?: string; severityText?: string; body?: unknown; raw?: string }> };
        const lines = events
          .filter((event) => event.service === "identity" || event.service === "devctl")
          .slice(-40)
          .map((event) => `  ${event.severityText ?? ""} ${event.service ?? ""} ${event.raw ?? JSON.stringify(event.body)}`);
        throw new Error(
          [`${err instanceof Error ? err.message : String(err)}`, `identity: state=${rt?.state} health=${rt?.health} pid=${rt?.pid} last_error=${rt?.last_error}`, "logs:", ...lines].join("\n"),
        );
      });
      expect(plan.waves.flat()).toContain("identity");
      const rt = sup.snapshot().services.identity;
      expect(rt?.pid ?? 0).toBeGreaterThan(0);
      await sup.stop(["identity"]);
      expect(sup.snapshot().services.identity?.state).toBe("STOPPED");
    } finally {
      await sup.stop(["identity"]);
    }
  }, 30_000);
});
