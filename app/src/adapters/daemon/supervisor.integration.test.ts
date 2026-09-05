import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { load } from "../config/index.ts";
import { Supervisor } from "../../bootstrap/test-supervisor.ts";

describe("demo-platform integration", () => {
  test("starts and stops the Python identity service without Google", async () => {
    const home = `${process.env.TMPDIR ?? "/tmp"}/devctl-int-${Date.now()}`;
    mkdirSync(home, { recursive: true });
    process.env.DEVCTL_HOME = home;
    const root = resolve(import.meta.dir, "../../../../examples/demo-platform");
    const cfg = load(root, "");
    cfg.logs.persistence.enabled = false;
    cfg.proxy.enabled = false;
    for (const svc of Object.values(cfg.services)) {
      svc.identity = { type: "", mode: "", service_account: "" };
    }
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
      const plan = await sup.start({ services: ["identity"] });
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
