import { describe, expect, test } from "bun:test";
import { defaultConfig, dependencyName, emptyHttpRecipe, emptyRouteAuth, emptyService } from "../config/types.ts";
import { effectiveStartupDependencies, recipeCycleIssues, recipesNeededForEnv, implicitServiceDependencies } from "./recipes.ts";

describe("http recipes", () => {
  test("walks chained recipe refs and implicit service deps", () => {
    const cfg = defaultConfig();
    cfg.services.identity = emptyService();
    cfg.services.identity.health.type = "http";
    cfg.http.inner = {
      ...emptyHttpRecipe(),
      request: { ...emptyHttpRecipe().request, url: "${services.identity.url}/token", auth: emptyRouteAuth() },
      outputs: { token: "access_token" },
    };
    cfg.http.outer = {
      ...emptyHttpRecipe(),
      request: { ...emptyHttpRecipe().request, url: "https://example/${http.inner.token}", auth: emptyRouteAuth() },
      outputs: { token: "access_token" },
    };
    const env = { vars: { T: "${http.outer.token}" }, required: [], defaults: {} };
    expect(recipesNeededForEnv(cfg, env)).toEqual(["outer", "inner"]);
    expect(implicitServiceDependencies(cfg, env)).toEqual([{ service: "identity", condition: "service_healthy" }]);
  });

  test("a pre_start environment reference pulls its service in before startup", () => {
    const cfg = defaultConfig();
    cfg.services.api = emptyService();
    cfg.services.api.command = { args: ["api"], shell: false };
    cfg.services.db = emptyService();
    cfg.services.db.command = { args: ["db"], shell: false };
    cfg.services.db.health.type = "process";
    cfg.http.migrate = {
      ...emptyHttpRecipe(),
      request: { ...emptyHttpRecipe().request, url: "${services.db.url}/migrate" },
      outputs: { ok: "ok" },
    };
    cfg.services.api.hooks.pre_start = {
      command: { args: ["migrate"], shell: false },
      environment: { vars: { TOKEN: "${http.migrate.ok}" }, required: [], defaults: {} },
    };
    expect(effectiveStartupDependencies(cfg, "api").map((dep) => dependencyName(dep))).toContain("db");
  });

  test("reports recipe cycles", () => {
    const cfg = defaultConfig();
    cfg.http.a = { ...emptyHttpRecipe(), request: { ...emptyHttpRecipe().request, url: "${http.b.token}" }, outputs: { token: "t" } };
    cfg.http.b = { ...emptyHttpRecipe(), request: { ...emptyHttpRecipe().request, url: "${http.a.token}" }, outputs: { token: "t" } };
    expect(recipeCycleIssues(cfg)[0]).toContain("http recipe cycle");
  });
});
