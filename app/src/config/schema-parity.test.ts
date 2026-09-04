import { describe, expect, test } from "bun:test";
import {
  knownAuth,
  knownContainer,
  knownDoctor,
  knownEnvStructured,
  knownGoogle,
  knownHealth,
  knownHooks,
  knownIdentity,
  knownListen,
  knownLogs,
  knownMatch,
  knownPersistence,
  knownPlugin,
  knownProfile,
  knownProject,
  knownProjectEnvironment,
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
import { servicePathKnown } from "./strict.ts";

type SchemaNode = { properties?: Record<string, SchemaNode>; items?: SchemaNode; oneOf?: SchemaNode[]; $ref?: string; $defs?: Record<string, SchemaNode> };
const schema = (await Bun.file(new URL("../../../schema/devctl.config.schema.json", import.meta.url)).json()) as SchemaNode;

function at(...path: string[]): SchemaNode {
  let node = schema;
  for (const part of path) {
    if (part === "items") node = node.items ?? {};
    else if (part === "identityObject") node = node.oneOf?.[1] ?? {};
    else if (part === "$defs") node = schema.$defs ?? {} as SchemaNode;
    else node = node.properties?.[part] ?? (node as unknown as Record<string, SchemaNode>)[part] ?? {};
  }
  return node;
}

function propertyNames(node: SchemaNode): string[] {
  return Object.keys(node.properties ?? {}).sort();
}

function expectParity(name: string, known: string[], node: SchemaNode): void {
  expect(known.slice().sort(), `${name} differs from schema/devctl.config.schema.json`).toEqual(propertyNames(node));
}

describe("config allowlist/schema parity", () => {
  test("every object allowlist matches its JSON schema properties", () => {
    const defs = schema.$defs ?? {};
    const service = defs.service ?? {};
    const proxy = defs.proxy ?? {};
    const route = defs.route ?? {};
    const logs = defs.logs ?? {};
    const cases: Array<[string, string[], SchemaNode]> = [
      ["knownTopLevel", knownTopLevel, schema],
      ["knownProject", knownProject, at("project")],
      ["knownGoogle", knownGoogle, at("google")],
      ["knownService", knownService, service],
      ["knownHealth", knownHealth, service.properties?.health ?? {}],
      ["knownIdentity", knownIdentity, service.properties?.identity ?? {}],
      ["knownRestart", knownRestart, service.properties?.restart ?? {}],
      ["knownStartup", knownStartup, service.properties?.startup ?? {}],
      ["knownServiceLogs", knownServiceLogs, service.properties?.logs ?? {}],
      ["knownContainer", knownContainer, service.properties?.container ?? {}],
      ["knownHooks", knownHooks, service.properties?.hooks ?? {}],
      ["knownTask", knownTask, defs.task ?? {}],
      ["knownEnvStructured", knownEnvStructured, defs.serviceEnvironment ?? {}],
      ["knownProxy", knownProxy, proxy],
      ["knownListen", knownListen, proxy.properties?.listen ?? {}],
      ["knownTokenEndpoint", knownTokenEndpoint, proxy.properties?.token_endpoint ?? {}],
      ["knownRoute", knownRoute, route],
      ["knownMatch", knownMatch, route.properties?.match ?? {}],
      ["knownUpstream", knownUpstream, route.properties?.upstream ?? {}],
      ["knownRouteAuth", knownRouteAuth, route.properties?.auth ?? {}],
      ["knownLogs", knownLogs, logs],
      ["knownPersistence", knownPersistence, logs.properties?.persistence ?? {}],
      ["knownAuth", knownAuth, at("auth")],
      ["knownShutdown", knownShutdown, at("shutdown")],
      ["knownUI", knownUI, at("ui")],
      ["knownSecrets", knownSecrets, at("secrets")],
      ["knownDoctor", knownDoctor, at("doctor")],
      ["knownTool", knownTool, at("doctor", "tools", "items")],
      ["knownPlugin", knownPlugin, at("plugins", "items")],
      ["knownProjectEnvironment", knownProjectEnvironment, at("environment")],
      ["knownProfile", knownProfile, defs.profile ?? {}],
    ];
    for (const [name, known, node] of cases) expectParity(name, known, node);
  });

  test("every nested service object has an explicit strict-path case", () => {
    const service = schema.$defs?.service ?? {};
    const nested = ["health", "identity", "restart", "startup", "logs", "environment", "proxy", "container", "hooks"];
    for (const field of nested) {
      expect(knownService, `${field} is in the schema but not knownService`).toContain(field);
      expect(service.properties, `${field} is missing from schema/devctl.config.schema.json`).toHaveProperty(field);
      expect(servicePathKnown(`services.example.${field}`), `add a ${field} case to config/strict.ts`).not.toEqual([]);
    }
  });
});
