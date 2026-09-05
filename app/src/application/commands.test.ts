import { expect, test } from "bun:test";
import { defaultConfig } from "../domain/config/types.ts";
import type { DoctorProgress, DoctorRuntimeContext, Report } from "../domain/doctor/types.ts";
import type { DoctorRunner } from "../ports/doctor-runner.ts";
import { RunDoctor } from "./commands.ts";

test("doctor can run through a replacement port with progress and daemon context", async () => {
  const cfg = defaultConfig();
  const runtime: DoctorRuntimeContext = { services: { api: { pid: 42, ports: { http: 8080 } } }, repositoryConfigError: "invalid local YAML" };
  const report: Report = { checks: [{ name: "Repository configuration", severity: "error", message: "invalid local YAML" }], issues: 1 };
  const updates: DoctorProgress[] = [];
  const runner: DoctorRunner = {
    run: async (observedConfig, onProgress, observedRuntime) => {
      expect(observedConfig).toBe(cfg);
      expect(observedRuntime).toBe(runtime);
      onProgress?.({ active: "Diagnostics complete", checks: report.checks });
      return report;
    },
  };
  expect(await new RunDoctor(runner).execute(cfg, (progress) => updates.push(progress), runtime)).toBe(report);
  expect(updates).toEqual([{ active: "Diagnostics complete", checks: report.checks }]);
});

test("a failed doctor runner propagates its error to the caller", async () => {
  const error = new Error("diagnostic runner unavailable");
  const command = new RunDoctor({ run: async () => { throw error; } });
  await expect(command.execute(defaultConfig())).rejects.toBe(error);
});
