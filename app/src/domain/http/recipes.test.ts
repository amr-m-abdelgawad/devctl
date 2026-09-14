import { describe, expect, test } from "bun:test";
import { defaultConfig, emptyHttpRecipe, emptyRouteAuth, emptyService } from "../config/types.ts";
import { recipeCycleIssues, recipesNeededForEnv, implicitServiceDependencies } from "./recipes.ts";

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

  test("reports recipe cycles", () => {
    const cfg = defaultConfig();
    cfg.http.a = { ...emptyHttpRecipe(), request: { ...emptyHttpRecipe().request, url: "${http.b.token}" }, outputs: { token: "t" } };
    cfg.http.b = { ...emptyHttpRecipe(), request: { ...emptyHttpRecipe().request, url: "${http.a.token}" }, outputs: { token: "t" } };
    expect(recipeCycleIssues(cfg)[0]).toContain("http recipe cycle");
  });
});
