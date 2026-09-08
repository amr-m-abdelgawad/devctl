import { Detector } from "../secrets/detector.ts";
import { loadPluginPaths } from "../plugins/registry.ts";
import { defaultLogParser, LogManager } from "./logs.ts";
import type { WorkerRequest, WorkerResponse } from "./log-worker-protocol.ts";

let manager: LogManager | undefined;
let detector: Detector | undefined;
let chain = Promise.resolve();

function reply(message: WorkerResponse): void {
  postMessage(message);
}

function fail(id: number | undefined, err: unknown): void {
  if (id === undefined) {
    return;
  }
  reply({ id, type: "error", error: err instanceof Error ? err.message : String(err) });
}

async function handle(message: WorkerRequest): Promise<void> {
  if (message.type === "init") {
    detector = new Detector(message.config.extraMarkers, message.config.extraPatterns);
    manager = new LogManager(
      message.config.max,
      undefined,
      detector,
      message.config.persist,
      message.config.directory,
      message.config.sessionID,
      message.config.retentionDays,
      message.config.maxSessionLogs,
    );
    manager.setParsers([defaultLogParser()]);
    reply({ type: "ready" });
    return;
  }
  if (message.type === "setSecrets") {
    detector?.update(message.extraMarkers, message.extraPatterns);
    return;
  }
  if (message.type === "setPluginPaths") {
    const registry = await loadPluginPaths(message.paths);
    manager?.setParsers(registry.logParsers);
    return;
  }
  if (!manager) {
    fail("id" in message ? message.id : undefined, new Error("log worker is not initialized"));
    return;
  }
  if (message.type === "append") {
    const event = manager.append(message.event);
    reply({ type: "appended", event, stats: manager.snapshot() });
    return;
  }
  if (message.type === "query") {
    reply({ id: message.id, type: "result", result: manager.query(message.filter) });
    return;
  }
  if (message.type === "queryPage") {
    reply({ id: message.id, type: "result", result: manager.queryPage(message.filter, message.page) });
    return;
  }
  if (message.type === "queryFacets") {
    reply({ id: message.id, type: "result", result: manager.queryFacets(message.filter) });
    return;
  }
  if (message.type === "exportTo") {
    manager.exportTo(message.path, message.filter);
    reply({ id: message.id, type: "result", result: null });
    return;
  }
  await manager.close();
  reply({ id: message.id, type: "result", result: null });
}

addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  chain = chain.then(() => handle(event.data)).catch((err: unknown) => {
    const data = event.data;
    fail("id" in data ? data.id : undefined, err);
  });
});
