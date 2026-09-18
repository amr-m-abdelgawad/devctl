import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { load } from "../../adapters/config/load.ts";
import { resolveStartRequest, startupPlan } from "../../domain/service/services.ts";
import { defaultProfileName, formatStarted, noneStarted } from "./helpers.ts";

describe("demo-platform TUI first-run flow", () => {
  test("empty dashboard starts backend in dependency order", () => {
    const cfg = load(resolve(import.meta.dir, "../../../../examples/demo-platform"), "");
    const profile = defaultProfileName(cfg);
    expect(profile).toBe("backend");
    expect(noneStarted(undefined)).toBe(true);
    const resolved = resolveStartRequest(cfg, {});
    expect(String(resolved.profile)).toBe("backend");
    const plan = startupPlan(cfg, resolved.services, resolved.profile);
    expect(plan.waves.flat()).toEqual(["identity", "llm", "invoices-api", "telemetry", "invoices-worker"]);
    expect(formatStarted(plan)).toBe("Started identity → llm → invoices-api → telemetry → invoices-worker");
    const consolePlan = startupPlan(cfg, ["billing-console"], "console");
    expect(consolePlan.waves.flat()).toEqual(["billing-console"]);
    expect(consolePlan.blockers).toEqual([]);
  });
});
