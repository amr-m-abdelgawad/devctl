import type { DevctlConfig } from "./types.ts";
import type { ReloadResult } from "../../types.ts";

export type ConfigSnapshot = DevctlConfig;
export type ConfigDiff = ReloadResult;

export function replaceSnapshot(_previous: ConfigSnapshot, next: ConfigSnapshot): ConfigSnapshot {
  return next;
}

export function configSnapshotDiff(prev: ConfigSnapshot, next: ConfigSnapshot): ConfigDiff {
  const changes: Record<string, string[]> = {};
  const restart = new Set<string>();
  const names = new Set([...Object.keys(prev.services), ...Object.keys(next.services)]);
  for (const name of names) {
    const before = prev.services[name];
    const after = next.services[name];
    const fields: string[] = [];
    if (!before || !after) {
      fields.push("presence");
      restart.add(name);
    } else {
      if (
        before.command.args.join("\0") !== after.command.args.join("\0") ||
        before.command.shell !== after.command.shell ||
        before.shell !== after.shell
      ) {
        fields.push("command");
        restart.add(name);
      }
      if (before.working_dir !== after.working_dir) {
        fields.push("working_dir");
        restart.add(name);
      }
      if (JSON.stringify(before.environment) !== JSON.stringify(after.environment)) {
        fields.push("environment");
        restart.add(name);
      }
      if (JSON.stringify(before.ports) !== JSON.stringify(after.ports)) {
        fields.push("ports");
        restart.add(name);
      }
      if (JSON.stringify(before.identity) !== JSON.stringify(after.identity)) {
        fields.push("identity");
        restart.add(name);
      }
      if (JSON.stringify(before.health) !== JSON.stringify(after.health)) {
        fields.push("health");
        restart.add(name);
      }
      if (JSON.stringify(before.restart) !== JSON.stringify(after.restart)) {
        fields.push("restart");
        restart.add(name);
      }
      if (JSON.stringify(before.startup) !== JSON.stringify(after.startup)) {
        fields.push("startup");
        restart.add(name);
      }
      if (JSON.stringify(before.logs) !== JSON.stringify(after.logs)) {
        fields.push("logs");
        restart.add(name);
      }
      if (JSON.stringify(before.container) !== JSON.stringify(after.container)) {
        fields.push("container");
        restart.add(name);
      }
    }
    if (fields.length > 0) {
      changes[name] = fields;
    }
  }
  const supervisorRestart: string[] = [];
  if (JSON.stringify(prev.logs) !== JSON.stringify(next.logs)) {
    supervisorRestart.push("logs");
  }
  if (JSON.stringify(prev.auth) !== JSON.stringify(next.auth)) {
    supervisorRestart.push("auth");
  }
  if (JSON.stringify(prev.plugins) !== JSON.stringify(next.plugins)) {
    supervisorRestart.push("plugins");
  }
  return {
    restart_required: [...restart].sort(),
    changes,
    supervisor_restart_required: supervisorRestart,
  };
}
