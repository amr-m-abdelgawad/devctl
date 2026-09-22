import { describe, expect, test } from "bun:test";
import {
  knownAuth,
  knownContainer,
  knownDoctor,
  knownDependency,
  knownEnvStructured,
  knownExpose,
  knownGoogle,
  knownHealth,
  knownHooks,
  knownHttp,
  knownHttpCache,
  knownHttpExpose,
  knownHttpRequest,
  knownIdentity,
  knownListen,
  knownLogs,
  knownMatch,
  knownPersistence,
  knownPlugin,
  knownProfile,
  knownProject,
  knownProjectEnvironment,
  knownSops,
  knownProxy,
  knownRestart,
  knownRoute,
  knownRouteAuth,
  knownRouteInspect,
  knownRouteInspectGrpc,
  knownRouteLog,
  knownRouteLogGrpc,
  knownRouteLogGrpcOk,
  knownRouteTimeout,
  knownRouteTransform,
  knownRequestBodyReplacement,
  knownSecrets,
  knownService,
  knownServiceLogs,
  knownServiceLogMultiline,
  knownShutdown,
  knownStartup,
  knownTokenEndpoint,
  knownTool,
  knownTopLevel,
  knownTask,
  knownTelemetry,
  knownTelemetryOtlp,
  knownUI,
  knownUpstream,
  knownWatch,
  knownWeb,
  knownLlm,
  knownLlmSource,
  knownLlmAuth,
  knownLlmVia,
  knownLlmCapture,
  knownLlmCaptureFieldMap,
  knownLlmCostPerToken,
} from "./known.ts";
import { collectUnknownFields, servicePathKnown } from "./strict.ts";

type SchemaNode = { properties?: Record<string, SchemaNode>; items?: SchemaNode; oneOf?: SchemaNode[]; $ref?: string; $defs?: Record<string, SchemaNode> };
const schema = (await Bun.file(new URL("../../../../schema/devctl.config.schema.json", import.meta.url)).json()) as SchemaNode;

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
      ["knownServiceLogMultiline", knownServiceLogMultiline, service.properties?.logs?.properties?.multiline ?? {}],
      ["knownContainer", knownContainer, service.properties?.container ?? {}],
      ["knownWatch", knownWatch, service.properties?.watch ?? {}],
      ["knownDependency", knownDependency, defs.dependency ?? {}],
      ["knownHooks", knownHooks, service.properties?.hooks ?? {}],
      ["knownExpose", knownExpose, (service.properties?.expose?.oneOf ?? []).find((node) => node.properties) ?? {}],
      ["knownTask", knownTask, defs.task ?? {}],
      ["knownHttp", knownHttp, defs.httpRecipe ?? {}],
      ["knownHttpRequest", knownHttpRequest, defs.httpRecipe?.properties?.request ?? {}],
      ["knownHttpCache", knownHttpCache, defs.httpRecipe?.properties?.cache ?? {}],
      ["knownHttpExpose", knownHttpExpose, (defs.httpRecipe?.properties?.expose?.oneOf ?? []).find((node) => node.properties) ?? {}],
      ["knownEnvStructured", knownEnvStructured, defs.serviceEnvironment ?? {}],
      ["knownProxy", knownProxy, proxy],
      ["knownListen", knownListen, proxy.properties?.listen ?? {}],
      ["knownTokenEndpoint", knownTokenEndpoint, proxy.properties?.token_endpoint ?? {}],
      ["knownRoute", knownRoute, route],
      ["knownMatch", knownMatch, route.properties?.match ?? {}],
      ["knownUpstream", knownUpstream, route.properties?.upstream ?? {}],
      ["knownRouteAuth", knownRouteAuth, route.properties?.auth ?? {}],
      ["knownRouteInspect", knownRouteInspect, defs.routeInspect ?? {}],
      ["knownRouteInspectGrpc", knownRouteInspectGrpc, defs.routeInspect?.properties?.grpc ?? {}],
      ["knownRouteLog", knownRouteLog, defs.routeLog ?? {}],
      ["knownRouteLogGrpc", knownRouteLogGrpc, defs.routeLogGrpc ?? {}],
      ["knownRouteLogGrpcOk", knownRouteLogGrpcOk, defs.routeLogGrpcOk ?? {}],
      ["knownRouteTimeout", knownRouteTimeout, defs.routeTimeout ?? {}],
      ["knownRouteTransform", knownRouteTransform, defs.routeTransform ?? {}],
      ["knownRequestBodyReplacement", knownRequestBodyReplacement, defs.requestBodyReplacement ?? {}],
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
      ["knownSops", knownSops, at("environment", "sops")],
      ["knownProfile", knownProfile, defs.profile ?? {}],
      ["knownTelemetry", knownTelemetry, defs.telemetry ?? {}],
      ["knownTelemetryOtlp", knownTelemetryOtlp, defs.telemetry?.properties?.otlp ?? {}],
      ["knownWeb", knownWeb, defs.web ?? {}],
      ["knownLlm", knownLlm, defs.llm ?? {}],
      ["knownLlmSource", knownLlmSource, defs.llmSource ?? {}],
      ["knownLlmAuth", knownLlmAuth, defs.llmAuth ?? {}],
      ["knownLlmVia", knownLlmVia, defs.llmVia ?? {}],
      ["knownLlmCapture", knownLlmCapture, defs.llmCapture ?? {}],
      ["knownLlmCaptureFieldMap", knownLlmCaptureFieldMap, defs.llmCaptureFieldMap ?? {}],
      ["knownLlmCostPerToken", knownLlmCostPerToken, defs.llmCostPerToken ?? {}],
    ];
    for (const [name, known, node] of cases) expectParity(name, known, node);
  });

  test("unknown cost_per_token.foo is rejected; input and output are known", () => {
    expect(collectUnknownFields({
      sources: [{ name: "x", type: "proxy", cost_per_token: { input: 1, output: 2, foo: true } }],
    }, "llm")).toContain("llm.sources.0.cost_per_token.foo");
    expect(collectUnknownFields({
      sources: [{ name: "x", type: "proxy", cost_per_token: { input: 1, output: 2 } }],
    }, "llm")).toEqual([]);
  });

  test("unknown via.foo is rejected; via.routes is known", () => {
    expect(collectUnknownFields({
      sources: [{ name: "x", type: "proxy", via: { route: "a", routes: ["b"], foo: true } }],
    }, "llm")).toContain("llm.sources.0.via.foo");
    expect(collectUnknownFields({
      sources: [{ name: "x", type: "proxy", via: { route: "a", routes: ["b"] } }],
    }, "llm")).toEqual([]);
  });

  test("unknown capture.field_map.foo is rejected; model is known", () => {
    expect(collectUnknownFields({
      sources: [{ name: "x", type: "proxy", capture: { field_map: { model: "$.request.model_name", foo: true } } }],
    }, "llm")).toContain("llm.sources.0.capture.field_map.foo");
    expect(collectUnknownFields({
      sources: [{ name: "x", type: "proxy", capture: { field_map: { model: "$.request.model_name" } } }],
    }, "llm")).toEqual([]);
  });

  test("unknown logs.multiline.foo is rejected", () => {
    expect(collectUnknownFields({
      logs: { stdout: true, multiline: { start: "^", foo: true } },
    }, "services.api")).toContain("services.api.logs.multiline.foo");
  });

  test("logs.dedupe_access_line is known and logs.access_log is not", () => {
    expect(collectUnknownFields({
      logs: { stdout: true, dedupe_access_line: true },
    }, "services.api")).toEqual([]);
    expect(collectUnknownFields({
      logs: { stdout: true, access_log: { enabled: true } },
    }, "services.api")).toContain("services.api.logs.access_log");
  });

  test("unknown transform keys are rejected on a route and a service proxy fragment", () => {
    expect(collectUnknownFields({
      routes: [{ name: "api", transform: { request_body: [{ replace: "a", with: "b", regex: true, foo: true }], extra: true } }],
    }, "proxy")).toEqual(["proxy.routes.0.transform.request_body.0.foo", "proxy.routes.0.transform.extra"]);
    expect(collectUnknownFields({
      match: { path: "/api" },
      transform: { request_body: [{ replace: "a", with: "b" }] },
    }, "services.api.proxy")).toEqual([]);
    expect(collectUnknownFields({
      proxy: [{ match: { path: "/api" }, transform: { request_body: [{ replace: "a", with: "b", extra: true }] } }],
    }, "services.api")).toContain("services.api.proxy.0.transform.request_body.0.extra");
  });

  test("unknown timeout.foo is rejected on a route and a service proxy fragment", () => {
    expect(collectUnknownFields({
      routes: [{ name: "api", timeout: { idle_ms: 1, foo: true } }],
    }, "proxy")).toContain("proxy.routes.0.timeout.foo");
    expect(collectUnknownFields({
      match: { path: "/api" },
      timeout: { total_ms: 1, foo: true },
    }, "services.api.proxy")).toContain("services.api.proxy.timeout.foo");
  });

  test("every nested service object has an explicit strict-path case", () => {
    const service = schema.$defs?.service ?? {};
    const nested = ["health", "identity", "restart", "startup", "logs", "environment", "proxy", "expose", "container", "watch", "hooks"];
    for (const field of nested) {
      expect(knownService, `${field} is in the schema but not knownService`).toContain(field);
      expect(service.properties, `${field} is missing from schema/devctl.config.schema.json`).toHaveProperty(field);
      expect(servicePathKnown(`services.example.${field}`), `add a ${field} case to config/strict.ts`).not.toEqual([]);
    }
  });
});
