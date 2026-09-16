import type { DevctlConfig, ServiceConfig } from "./types.ts";
import { recipesReferencedInEnv } from "../http/recipes.ts";
import { allServiceEnvConfigs } from "../service/environments.ts";
import type { ReloadResult } from "../status.ts";

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
      if (JSON.stringify(before.environment) !== JSON.stringify(after.environment) || JSON.stringify(before.environments) !== JSON.stringify(after.environments) || before.default_environment !== after.default_environment) {
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
      if (JSON.stringify(before.watch) !== JSON.stringify(after.watch)) {
        fields.push("watch");
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
  if (JSON.stringify(prev.telemetry) !== JSON.stringify(next.telemetry)) {
    supervisorRestart.push("telemetry");
  }
  if (JSON.stringify(prev.web) !== JSON.stringify(next.web)) {
    supervisorRestart.push("web");
  }
  if (JSON.stringify(prev.auth) !== JSON.stringify(next.auth)) {
    supervisorRestart.push("auth");
  }
  if (JSON.stringify(prev.http) !== JSON.stringify(next.http)) {
    for (const [name, svc] of Object.entries(next.services)) {
      const refs = uniqueRecipeRefs(svc);
      const recipeChanged = refs.some((recipeName) => JSON.stringify(prev.http[recipeName]) !== JSON.stringify(next.http[recipeName]));
      if (recipeChanged) {
        const fields = changes[name] ?? [];
        if (!fields.includes("http")) {
          fields.push("http");
        }
        changes[name] = fields;
        restart.add(name);
      }
    }
  }
  // Plugin *path list* hot-applies on reload. Same-path mtime still needs a
  // supervisor restart (Bun module cache) — that check lives in the adapter.
  return {
    restart_required: [...restart].sort(),
    changes,
    supervisor_restart_required: supervisorRestart,
  };
}

function uniqueRecipeRefs(svc: ServiceConfig): string[] {
  const names: string[] = [];
  for (const env of allServiceEnvConfigs(svc)) {
    for (const recipeName of recipesReferencedInEnv(env)) {
      if (!names.includes(recipeName)) {
        names.push(recipeName);
      }
    }
  }
  return names;
}
