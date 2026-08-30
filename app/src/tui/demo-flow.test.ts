import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { load } from "../config/load.ts";
import { resolveProfile, startupPlan } from "../services.ts";
import { defaultProfileName, formatStarted, noneStarted } from "./helpers.ts";

describe("demo-platform TUI first-run flow", () => {
  test("empty dashboard starts backend in dependency order", () => {
    const cfg = load(resolve(import.meta.dir, "../../../examples/demo-platform"), "");
    const profile = defaultProfileName(cfg);
    expect(profile).toBe("backend");
    expect(noneStarted(undefined)).toBe(true);
    const resolved = resolveProfile(cfg, profile, []);
    const plan = startupPlan(cfg, resolved.services, profile);
    expect(plan.waves.flat()).toEqual(["identity", "invoices-api", "invoices-worker"]);
    expect(formatStarted(plan)).toBe("Started identity → invoices-api → invoices-worker");
  });
});
