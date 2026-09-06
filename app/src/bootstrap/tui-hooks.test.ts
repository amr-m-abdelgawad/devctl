import { test, expect } from "bun:test";
import { act, createElement, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createClient } from "./client.ts";
import { defaultConfig } from "../domain/config/types.ts";
import type { DoctorProgress, Report } from "../domain/doctor/types.ts";
import type { LogEvent } from "../domain/logs/logs.ts";
import { defaultTuiConfig } from "../domain/ui/preferences.ts";
import { createTuiWorkspace } from "../presentation/tui/workspace.ts";
import { useDiagnostics } from "../presentation/tui/hooks/use-diagnostics.ts";
import { useLogView } from "../presentation/tui/hooks/use-log-view.ts";
import { useServiceEnvironment } from "../presentation/tui/hooks/use-service-environment.ts";
import type { Controller } from "../application/client-runtime.ts";

async function mountHook<P, T>(hook: (props: P) => T, initial: P) {
  let current: T;
  let update: (props: P) => void;
  function Harness() {
    const [props, setProps] = useState(initial);
    update = setProps;
    current = hook(props);
    return null;
  }
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => { setup = await testRender(createElement(Harness), { width: 40, height: 5 }); });
  return {
    get value() { return current!; },
    async update(props: P) { await act(async () => update(props)); },
    async close() { await act(async () => setup.renderer.destroy()); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("diagnostics preserves progress and ignores an older run finishing after a rerun", async () => {
  const client = createClient();
  client.detectGoogle = async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" });
  const workspace = createTuiWorkspace(client);
  const cfg = defaultConfig();
  const runs: { result: ReturnType<typeof deferred<Report>>; progress?: (progress: DoctorProgress) => void }[] = [];
  workspace.runDoctor = async (observed, progress) => {
    expect(observed).toBe(cfg);
    const result = deferred<Report>();
    runs.push({ result, progress });
    return result.promise;
  };
  const mounted = await mountHook(useDiagnostics, { workspace, cfg, screen: "doctor", setSnap: () => {}, setStatus: () => {} });
  try {
    expect(runs).toHaveLength(1);
    await act(async () => runs[0]!.progress?.({ active: "Checking credentials", checks: [] }));
    expect(mounted.value.doctorProgress.active).toBe("Checking credentials");
    await act(async () => mounted.value.setDoctorTick((tick) => tick + 1));
    expect(runs).toHaveLength(2);
    const newest: Report = { issues: 0, checks: [{ name: "latest", severity: "ok", message: "ready" }] };
    await act(async () => runs[1]!.result.resolve(newest));
    await act(async () => {
      runs[0]!.progress?.({ active: "Outdated", checks: [] });
      runs[0]!.result.resolve({ issues: 1, checks: [] });
    });
    expect(mounted.value.doctor).toBe(newest);
    expect(mounted.value.doctorProgress.active).not.toBe("Outdated");
    expect(mounted.value.doctorLoading).toBe(false);
  } finally { await mounted.close(); }
});

test("log view keeps a pinned window stable as new logs arrive and clears only its local view", async () => {
  const statuses: string[] = [];
  const mounted = await mountHook(useLogView, {
    tui: defaultTuiConfig(), names: ["api"], screen: "logs", refresh: async () => undefined,
    setStatus: (status: string) => { statuses.push(status); },
  });
  const events = Array.from({ length: 230 }, (_, i): LogEvent => ({ timestamp: new Date(1000 + i).toISOString(), service: "api", level: "INFO", message: `line ${i}`, source: "stdout", pid: 1, seq: i + 1, raw: `line ${i}` }));
  try {
    await act(async () => mounted.value.setLogs(events.slice(0, 220)));
    expect(mounted.value.logSlice).toHaveLength(200);
    await act(async () => mounted.value.applyLogCursor(0));
    expect(mounted.value.logPinned).toBe(true);
    const first = mounted.value.logSlice[0];
    await act(async () => mounted.value.setLogs(events));
    expect(mounted.value.logSlice[0]).toBe(first);
    expect(mounted.value.logWindow.newer).toBe(10);
    await act(async () => mounted.value.jumpToLatestLogs());
    expect(mounted.value.logPinned).toBe(false);
    expect(mounted.value.logSlice.at(-1)).toBe(events.at(-1));
    await act(async () => mounted.value.clearLogs());
    expect(mounted.value.logs).toEqual([]);
    expect(mounted.value.logSince).not.toBe("");
    expect(events).toHaveLength(230);
    expect(statuses.at(-1)).toBe("Cleared on-screen log buffer");
  } finally { await mounted.close(); }
});

test("environment inspection ignores a response for a previously focused service", async () => {
  const client = createClient();
  const cfg = client.loadPath("/virtual", "/virtual/.devctl/config.yaml", {
    candidateText: "version: 1\nservices:\n  api:\n    command: [echo, api]\n  worker:\n    command: [echo, worker]\n",
  });
  type Result = Awaited<ReturnType<Controller["execService"]>>;
  const api = deferred<Result>();
  const worker = deferred<Result>();
  const controller = { execService: (service: string) => service === "api" ? api.promise : worker.promise };
  const mounted = await mountHook(useServiceEnvironment, { cfg, controller, envService: "api" });
  try {
    await mounted.update({ cfg, controller, envService: "worker" });
    await act(async () => worker.resolve({ service: "worker", code: 0, stdout: "", stderr: "", environment: { NAME: "worker" } }));
    await act(async () => api.resolve({ service: "api", code: 0, stdout: "", stderr: "", environment: { NAME: "api" } }));
    expect(mounted.value.inspectorEnv).toEqual({ NAME: "worker" });
    expect(mounted.value.inspectorEnvStatus).toBe("resolved");
  } finally { await mounted.close(); }
});

test("lifecycle failure ends the busy plan and refreshes daemon state", async () => {
  const { useLifecycle } = await import("../presentation/tui/hooks/use-lifecycle.ts");
  const client = createClient();
  const cfg = client.loadPath("/virtual", "/virtual/.devctl/config.yaml", {
    candidateText: "version: 1\nservices:\n  api:\n    command: [echo, api]\n",
  });
  const workspace = createTuiWorkspace(client);
  const statuses: string[] = [];
  const calls: unknown[] = [];
  const controller = { start: async (request: unknown) => { calls.push(request); throw new Error("launch failed"); }, stop: async () => {}, restart: async () => {} };
  let refreshes = 0;
  const mounted = await mountHook(useLifecycle, {
    workspace, cfg, controller,
    refresh: async () => { refreshes++; return undefined; },
    setStatus: (status: string) => { statuses.push(status); },
    setOverlay: () => {},
  });
  try {
    await act(async () => mounted.value.beginStart(["api"], ""));
    expect(calls).toEqual([{ services: ["api"], profile: "" }]);
    expect(mounted.value.plan?.waves).toEqual([["api"]]);
    expect(mounted.value.lifecycle).toBe("start");
    expect(mounted.value.planBusy).toBe(false);
    expect(refreshes).toBe(1);
    expect(statuses.at(-1)).toBe("launch failed");
  } finally { await mounted.close(); }
});

test("App composes the extracted hooks in setup mode", async () => {
  const { App } = await import("../presentation/tui/App.tsx");
  const client = createClient();
  client.detectGoogle = async () => ({ gcloudInstalled: false, adcAvailable: false, userEmail: "", projectID: "", projectSource: "" });
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(createElement(App, { workspace: createTuiWorkspace(client), tui: defaultTuiConfig(), onQuit: () => {} }), { width: 100, height: 35 });
  });
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("setup");
  } finally { await act(async () => setup.renderer.destroy()); }
});

test("preference previews revert on navigation and overrides keep changes session-local", async () => {
  const { usePreferences } = await import("../presentation/tui/hooks/use-preferences.ts");
  let saved = 0;
  const statuses: string[] = [];
  const props: Parameters<typeof usePreferences>[0] = {
    tui: defaultTuiConfig(), controller: undefined, snap: undefined, terminalBackground: undefined,
    resolveTuiOverridePath: () => "/virtual/override.json", userTuiConfigPath: () => "/virtual/tui.json",
    saveTuiPreferences: () => { saved++; return "/virtual/tui.json"; },
    setStatus: (status) => { if (typeof status === "string") statuses.push(status); },
    setPaletteIndex: () => {}, setOverlay: () => {}, setConfirmKind: () => {}, setScreen: () => {}, setSelected: () => {}, screen: "settings",
  };
  const mounted = await mountHook(usePreferences, props);
  try {
    await act(async () => mounted.value.persistTheme("nord"));
    await act(async () => mounted.value.setThemeName("dracula"));
    expect(mounted.value.themeName).toBe("dracula");
    await mounted.update({ ...props, screen: "dashboard" });
    expect(mounted.value.themeName).toBe("nord");
    expect(saved).toBe(0);
    expect(statuses.at(-1)).toContain("session only");
  } finally { await mounted.close(); }
});

test("config editor validates the buffer before writing or requesting reload", async () => {
  const { useConfigEditor } = await import("../presentation/tui/hooks/use-config-editor.ts");
  const cfg = defaultConfig();
  let writes = 0;
  const mounted = await mountHook(useConfigEditor, {
    cfg, controller: undefined, readTextFile: () => "invalid buffer",
    writeTextFile: () => { writes++; },
    validateConfigText: (_repo, _path, text) => { expect(text).toBe("invalid buffer"); return ["Invalid YAML"]; },
    setOverlay: () => {}, setStatus: () => {}, setConfirmKind: () => {}, refresh: async () => undefined,
  });
  try {
    await act(async () => mounted.value.openConfigBuffer());
    await act(async () => mounted.value.saveConfigBuffer());
    expect(writes).toBe(0);
    expect(mounted.value.configEditError).toBe("Invalid YAML");
  } finally { await mounted.close(); }
});
