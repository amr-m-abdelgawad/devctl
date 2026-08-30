import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { load } from "./load.ts";

describe("demo-platform config", () => {
  test("loads the shared example", () => {
    const root = resolve(import.meta.dir, "../../../examples/demo-platform");
    const cfg = load(root, "");
    expect(cfg.project.name).toBe("demo-platform");
    expect(Object.keys(cfg.services).sort()).toEqual(["billing-console", "identity", "invoices-api", "invoices-worker"]);
    expect(cfg.profiles.backend?.services).toContain("invoices-worker");
    expect(cfg.proxy.listen.port).toBe(18080);
  });
});
