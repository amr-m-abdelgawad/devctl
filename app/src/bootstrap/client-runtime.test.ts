import { expect, test } from "bun:test";
import { createClient } from "./client.ts";
import { newRoot } from "../presentation/cli/cli.ts";
import { createTuiWorkspace } from "../presentation/tui/workspace.ts";
import { defaultConfig } from "../domain/config/types.ts";
import type { DoctorProgress, DoctorRuntimeContext, Report } from "../domain/doctor/types.ts";

test("CLI roots keep their injected setup and daemon operations isolated", async () => {
  const calls: unknown[][] = [];
  const first = createClient();
  const second = createClient();
  first.runSetup = async (...args) => { calls.push(["first", ...args]); };
  second.runSetup = async (...args) => { calls.push(["second", ...args]); };
  const rootA = newRoot(first, async (...args) => { calls.push(["daemon A", ...args]); });
  const rootB = newRoot(second, async (...args) => { calls.push(["daemon B", ...args]); });

  await rootA.parseAsync(["--config", "/virtual/a.yaml", "setup", "--force"], { from: "user" });
  await rootB.parseAsync(["--config", "/virtual/b.yaml", "setup"], { from: "user" });
  await rootA.parseAsync(["--config", "/virtual/a.yaml", "_supervisor", "--repo", "/virtual/repo"], { from: "user" });
  expect(calls).toEqual([
    ["first", "", "/virtual/a.yaml", true],
    ["second", "", "/virtual/b.yaml", false],
    ["daemon A", "/virtual/repo", "/virtual/a.yaml"],
  ]);
});

test("CLI config validation uses the supplied loader and validator", async () => {
  const client = createClient();
  const cfg = defaultConfig();
  const invalid = new Error("injected invalid configuration");
  const calls: string[][] = [];
  client.load = (...args) => { calls.push(args); return cfg; };
  client.validate = (loaded) => { expect(loaded).toBe(cfg); throw invalid; };
  const root = newRoot(client, async () => { throw new Error("unexpected daemon launch"); });
  await expect(root.parseAsync(["--config", "/virtual/config.yaml", "config", "validate"], { from: "user" })).rejects.toBe(invalid);
  expect(calls).toEqual([["", "/virtual/config.yaml"]]);
});

test("TUI workspace forwards diagnostics progress and attached daemon context", async () => {
  const cfg = defaultConfig();
  const context: DoctorRuntimeContext = { repositoryConfigError: "invalid local YAML", proxyRunning: true };
  const report: Report = { checks: [], issues: 0 };
  const updates: DoctorProgress[] = [];
  const client = createClient({ doctorRunner: {
    run: async (observed, onProgress, runtime) => {
      expect(observed).toBe(cfg);
      expect(runtime).toBe(context);
      onProgress?.({ active: "Complete", checks: [] });
      return report;
    },
  } });
  const workspace = createTuiWorkspace(client);
  expect(await workspace.runDoctor(cfg, (update) => updates.push(update), context)).toBe(report);
  expect(updates).toEqual([{ active: "Complete", checks: [] }]);
});
