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

test("profile commands preserve wire fields and resolve branded active/default profiles", async () => {
  const { StartProfile, StartService, ResolveStart } = await import("./commands.ts");
  const { profileId } = await import("../domain/ids.ts");
  const cfg = defaultConfig();
  cfg.profiles = { backend: { services: [], environment: { MODE: "backend" } }, full: { services: [], environment: { MODE: "full" } } };
  const requests: import("../domain/status.ts").StartRequest[] = [];
  const start = new StartService(async (request) => { requests.push(request); return { profile: request.profile ?? "", steps: [], waves: [] }; });
  const env = { FROM_CLIENT: "yes" };
  await new StartProfile(start).execute(profileId("backend"), env);
  expect(JSON.parse(JSON.stringify(requests[0]))).toEqual({ profile: "backend", client_env: env });
  const resolve = new ResolveStart();
  expect(String(resolve.execute(cfg, {}).profile)).toBe("backend");
  expect(resolve.execute(cfg, { activeProfile: profileId("full") }).env).toEqual({ MODE: "full" });
  expect(() => resolve.execute(cfg, { profile: profileId("missing") })).toThrow('unknown profile "missing"');
});

// Kept uncalled: TypeScript must reject unbranded names at these inner boundaries.
function profileBoundaryTypes(start: import("./commands.ts").StartProfile, resolve: import("./commands.ts").ResolveStart) {
  // @ts-expect-error Raw transport/UI strings must be converted at entry.
  void start.execute("backend");
  // @ts-expect-error The application resolver requires a ProfileId.
  resolve.execute(defaultConfig(), { profile: "backend" });
}
void profileBoundaryTypes;
