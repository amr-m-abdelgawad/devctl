import {
  knownAuth,
  knownContainer,
  knownDoctor,
  knownDependency,
  knownPlugin,
  knownProjectEnvironment,
  knownEnvStructured,
  knownGoogle,
  knownHealth,
  knownHooks,
  knownIdentity,
  knownListen,
  knownLogs,
  knownMatch,
  knownPersistence,
  knownProfile,
  knownProject,
  knownProxy,
  knownRestart,
  knownRoute,
  knownRouteAuth,
  knownSecrets,
  knownService,
  knownServiceLogs,
  knownShutdown,
  knownStartup,
  knownTokenEndpoint,
  knownTool,
  knownTopLevel,
  knownTask,
  knownUI,
  knownUpstream,
} from "./known.ts";

const ROUTE_DOT_COUNT = 2;

export function collectUnknownFields(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => collectUnknownFields(item, joinPath(path, String(index))));
  if (!isRecord(value)) {
    return [];
  }
  const known = knownForPath(path);
  const issues: string[] = [];
  for (const key of Object.keys(value)) {
    const childPath = joinPath(path, key);
    if (known.length > 0 && !known.includes(key) && !allowArbitraryKeys(path)) {
      issues.push(childPath);
    }
    issues.push(...collectUnknownFields(value[key], childPath));
  }
  return issues;
}

function allowArbitraryKeys(path: string): boolean {
  if (path === "services" || path === "profiles" || path === "templates" || path === "tasks") {
    return true;
  }
  if (path.endsWith(".environment") || path.endsWith(".defaults") || path.endsWith(".keymap")) {
    return true;
  }
  if (path.endsWith(".container.ports") || path.endsWith(".container.env")) {
    return true;
  }
  return path.includes(".environment.") && !path.endsWith(".environment");
}

function knownForPath(path: string): string[] {
  switch (path) {
    case "":
      return knownTopLevel;
    case "project":
      return knownProject;
    case "google":
      return knownGoogle;
    case "proxy":
      return knownProxy;
    case "proxy.listen":
      return knownListen;
    case "proxy.token_endpoint":
      return knownTokenEndpoint;
    case "logs":
      return knownLogs;
    case "logs.persistence":
      return knownPersistence;
    case "auth":
      return knownAuth;
    case "shutdown":
      return knownShutdown;
    case "ui":
      return knownUI;
    case "secrets":
      return knownSecrets;
    case "doctor":
      return knownDoctor;
    case "environment":
      return knownProjectEnvironment;
    default:
      return nestedKnown(path);
  }
}

function nestedKnown(path: string): string[] {
  if (path === "services" || path === "profiles" || path === "templates" || path === "tasks") {
    return [];
  }
  if (path.startsWith("services.") || path.startsWith("templates.")) {
    if (path.includes(".dependencies.")) return knownDependency;
    return servicePathKnown(path);
  }
  if (path.startsWith("profiles.")) {
    const parts = path.split(".");
    if (parts.length === 2) {
      return knownProfile;
    }
  }
  if (path.startsWith("tasks.")) {
    const parts = path.split(".");
    if (parts.length === 2) return knownTask;
    if (parts[2] === "environment") return knownEnvStructured;
  }
  if (path.includes("routes")) {
    return routePathKnown(path);
  }
  if (path.startsWith("doctor.tools") && path.split(".").length >= 3) {
    return knownTool;
  }
  if (path === "plugins") {
    return [];
  }
  if (path.startsWith("plugins.") && path.split(".").length === 2) {
    return knownPlugin;
  }
  return [];
}

export function servicePathKnown(path: string): string[] {
  const parts = path.split(".");
  if (parts.length === 2) {
    return knownService;
  }
  if (parts.length >= 3) {
    switch (parts[2]) {
      case "health":
        return knownHealth;
      case "identity":
        return knownIdentity;
      case "restart":
        return knownRestart;
      case "startup":
        return knownStartup;
      case "logs":
        return knownServiceLogs;
      case "environment":
        return knownEnvStructured;
      case "proxy":
        return serviceProxyPathKnown(parts);
      case "container":
        return knownContainer;
      case "hooks":
        return knownHooks;
      default:
        return [];
    }
  }
  return [];
}

function serviceProxyPathKnown(parts: string[]): string[] {
  const rest = parts.slice(3);
  const start = rest[0] !== undefined && /^\d+$/.test(rest[0]) ? 1 : 0;
  const kind = rest[start] ?? "";
  if (kind === "match") {
    return knownMatch;
  }
  if (kind === "upstream") {
    return knownUpstream;
  }
  if (kind === "auth") {
    return knownRouteAuth;
  }
  return knownRoute;
}

function routePathKnown(path: string): string[] {
  if (path === "proxy.routes") {
    return [];
  }
  if (path.endsWith(".match")) {
    return knownMatch;
  }
  if (path.endsWith(".upstream")) {
    return knownUpstream;
  }
  if (path.endsWith(".auth")) {
    return knownRouteAuth;
  }
  if (path.includes("proxy.routes") && path.split(".").length === ROUTE_DOT_COUNT + 1) {
    return knownRoute;
  }
  return [];
}

function joinPath(parent: string, key: string): string {
  if (parent === "") {
    return key;
  }
  return `${parent}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatUnknown(fields: string[]): string {
  return `unknown fields: ${fields.join(", ")}`;
}
