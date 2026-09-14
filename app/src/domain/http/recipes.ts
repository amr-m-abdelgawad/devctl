import { findTemplateRefs } from "../config/env-ref.ts";
import {
  dependencyName,
  isReservedHttpOutput,
  type Dependency,
  type DevctlConfig,
  type EnvConfig,
  type HttpRecipeConfig,
} from "../config/types.ts";

const PROCESS_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const JWT_TOKEN_FIELDS = ["access_token", "id_token", "token"] as const;

export function recipesReferencedIn(value: string): string[] {
  const names: string[] = [];
  for (const ref of findTemplateRefs(value)) {
    const parsed = parseHttpRef(ref);
    if (parsed && !names.includes(parsed.recipe)) {
      names.push(parsed.recipe);
    }
  }
  return names;
}

export function parseHttpRef(ref: string): { recipe: string; output: string } | undefined {
  const parts = ref.split(".");
  if (parts[0] !== "http" || parts.length !== 3 || !parts[1] || !parts[2]) {
    return undefined;
  }
  return { recipe: parts[1], output: parts[2] };
}

export function recipesReferencedInEnv(env: EnvConfig): string[] {
  return uniqueRefs([...Object.values(env.vars), ...Object.values(env.defaults)]);
}

export function recipesReferencedInMap(values: Record<string, string>): string[] {
  return uniqueRefs(Object.values(values));
}

function uniqueRefs(values: string[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    for (const name of recipesReferencedIn(value)) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

export function recipeRequestTexts(recipe: HttpRecipeConfig): string[] {
  return [
    recipe.request.url,
    recipe.request.body,
    ...Object.values(recipe.request.headers),
    ...Object.values(recipe.request.form),
    ...Object.values(recipe.request.auth.headers ?? {}),
  ];
}

export function httpRecipesReferencedBy(recipe: HttpRecipeConfig): string[] {
  return uniqueRefs(recipeRequestTexts(recipe));
}

export function servicesReferencedBy(recipe: HttpRecipeConfig): string[] {
  const names: string[] = [];
  for (const text of recipeRequestTexts(recipe)) {
    for (const ref of findTemplateRefs(text)) {
      const parts = ref.split(".");
      const svc = parts[0] === "services" ? parts[1] : undefined;
      if (svc && !names.includes(svc)) {
        names.push(svc);
      }
    }
  }
  return names;
}

export function recipeClosure(cfg: DevctlConfig, roots: string[]): string[] {
  const out: string[] = [];
  const visit = (name: string): void => {
    if (out.includes(name)) {
      return;
    }
    const recipe = cfg.http[name];
    if (!recipe) {
      return;
    }
    out.push(name);
    for (const dep of httpRecipesReferencedBy(recipe)) {
      visit(dep);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return out;
}

export function recipesNeededForEnv(cfg: DevctlConfig, env: EnvConfig, extra: Record<string, string> = {}): string[] {
  return recipeClosure(cfg, [...recipesReferencedInEnv(env), ...recipesReferencedInMap(extra)]);
}

export function implicitServiceDependencies(cfg: DevctlConfig, env: EnvConfig, extra: Record<string, string> = {}): Dependency[] {
  const services: string[] = [];
  for (const recipeName of recipesNeededForEnv(cfg, env, extra)) {
    const recipe = cfg.http[recipeName];
    if (recipe) {
      for (const svc of servicesReferencedBy(recipe)) {
        if (cfg.services[svc] && !services.includes(svc)) {
          services.push(svc);
        }
      }
    }
  }
  services.sort();
  return services.map((svc) => ({
    service: svc,
    condition: cfg.services[svc]?.health.type !== "" ? "service_healthy" : "service_started",
  }));
}

export function effectiveStartupDependencies(cfg: DevctlConfig, name: string, profileEnv: Record<string, string> = {}): Dependency[] {
  const svc = cfg.services[name];
  if (!svc) {
    return [];
  }
  const explicit = [...svc.dependencies];
  const seen = new Set(explicit.map((dep) => dependencyName(dep)));
  const out = [...explicit];
  for (const dep of implicitServiceDependencies(cfg, svc.environment, profileEnv)) {
    const depName = dependencyName(dep);
    if (!seen.has(depName) && depName !== name) {
      seen.add(depName);
      out.push(dep);
    }
  }
  return out;
}

export function directedCycleIssues(
  nodes: string[],
  neighbors: (name: string) => string[],
  format: (cycle: string[]) => string,
): string[] {
  const unseen = 0;
  const active = 1;
  const done = 2;
  const state: Record<string, number> = {};
  const issues: string[] = [];
  const stack: string[] = [];
  const visit = (name: string): void => {
    const current = state[name] ?? unseen;
    if (current === done) {
      return;
    }
    if (current === active) {
      issues.push(format([...stack, name]));
      return;
    }
    state[name] = active;
    stack.push(name);
    for (const dep of neighbors(name)) {
      visit(dep);
    }
    stack.pop();
    state[name] = done;
  };
  for (const name of nodes) {
    visit(name);
  }
  return issues;
}

export function recipeCycleIssues(cfg: DevctlConfig): string[] {
  return directedCycleIssues(
    Object.keys(cfg.http),
    (name) => {
      const recipe = cfg.http[name];
      return recipe ? httpRecipesReferencedBy(recipe).filter((dep) => Boolean(cfg.http[dep])) : [];
    },
    (cycle) => `http recipe cycle: ${cycle.join(" → ")}`,
  );
}

export function httpOutputDefined(cfg: DevctlConfig, recipeName: string, output: string): boolean {
  const recipe = cfg.http[recipeName];
  if (!recipe) {
    return false;
  }
  if (isReservedHttpOutput(output)) {
    return true;
  }
  return recipe.outputs[output] !== undefined;
}

export function isProcessEnvRef(ref: string): boolean {
  if (ref === "token") {
    return false;
  }
  const parts = ref.split(".");
  if (parts.length === 1) {
    return PROCESS_ENV_NAME.test(parts[0] ?? "");
  }
  return parts.length === 2 && parts[0] === "env" && PROCESS_ENV_NAME.test(parts[1] ?? "");
}

export function processEnvName(ref: string): string {
  const parts = ref.split(".");
  return parts.length === 2 && parts[0] === "env" ? (parts[1] ?? "") : (parts[0] ?? "");
}

export function recipeUsesToken(recipe: HttpRecipeConfig): boolean {
  return recipeRequestTexts(recipe).some((text) => findTemplateRefs(text).includes("token"));
}

export function recipeAuthMintsToken(recipe: HttpRecipeConfig): boolean {
  const type = recipe.request.auth.type.toLowerCase();
  return type === "iap" || type === "service_account";
}
