import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyService } from "../../domain/config/types.ts";
import { ServiceWatchers } from "./service-watch.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ServiceWatchers", () => {
  test("ignores disabled watch and whole-repo paths", () => {
    const root = join(tmpdir(), `devctl-watch-${Date.now()}`);
    mkdirSync(join(root, "api"), { recursive: true });
    temps.push(root);
    const logs: string[] = [];
    const watchers = new ServiceWatchers({
      repoRoot: () => root,
      log: (_service, _level, message) => logs.push(message),
      isActive: () => true,
      restart: async () => undefined,
    });
    const off = emptyService();
    const whole = emptyService();
    whole.watch = { ...whole.watch, enabled: true, paths: ["."] };
    const on = emptyService();
    on.watch = { ...on.watch, enabled: true, paths: ["api"] };
    watchers.sync({ idle: off, repo: whole, api: on });
    expect(watchers.watched()).toEqual(["api"]);
    expect(logs.some((line) => line.includes("whole-repo"))).toBe(true);
    watchers.sync({ idle: off });
    expect(watchers.watched()).toEqual([]);
    watchers.close();
  });
});
