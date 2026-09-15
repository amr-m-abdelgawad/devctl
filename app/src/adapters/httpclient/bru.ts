import { bruToJsonV2, bruToEnvJsonV2, collectionBruToJson } from "@usebruno/lang";
import {
  emptyHttpClientAuth,
  emptyHttpClientBody,
  emptyHttpClientRequest,
  type CollectionItem,
  type HttpClientAuth,
  type HttpClientAuthMode,
  type HttpClientBody,
  type HttpClientBodyMode,
  type HttpClientFormField,
  type HttpClientHeader,
  type HttpClientParam,
  type HttpClientRequest,
  type HttpClientVar,
} from "../../domain/httpclient/request.ts";

export function parseBruRequest(contents: string, id: string, fallbackName: string): HttpClientRequest {
  return bruJsonToRequest(bruToJsonV2(contents), id, fallbackName);
}

export function parseBruEnvironment(contents: string): HttpClientVar[] {
  return varsFromUnknown(bruToEnvJsonV2(contents));
}

export function parseCollectionBru(contents: string): { vars: HttpClientVar[]; auth: HttpClientAuth; headers: HttpClientHeader[] } {
  return collectionMetaFromUnknown(collectionBruToJson(contents));
}

export function bruJsonToRequest(raw: unknown, id: string, fallbackName: string): HttpClientRequest {
  const rec = asRecord(raw);
  const http = asRecord(rec.http);
  const meta = asRecord(rec.meta);
  const request = emptyHttpClientRequest();
  request.id = id;
  request.name = asString(meta.name) || fallbackName;
  request.method = (asString(http.method) || "GET").toUpperCase();
  request.url = asString(http.url);
  request.params = paramsFromUnknown(rec.params);
  request.headers = headersFromUnknown(rec.headers);
  request.body = bodyFromUnknown(rec.body, asString(http.body));
  request.auth = authFromUnknown(rec.auth, asString(http.auth));
  request.vars = varsFromRecord(asRecord(rec.vars).req);
  return request;
}

export function collectionMetaFromUnknown(raw: unknown): { vars: HttpClientVar[]; auth: HttpClientAuth; headers: HttpClientHeader[] } {
  const rec = asRecord(raw);
  return {
    vars: varsFromRecord(asRecord(rec.vars).req),
    auth: authFromUnknown(rec.auth, asString(asRecord(rec.auth).mode)),
    headers: headersFromUnknown(rec.headers),
  };
}

type NamedField = { name: string; value: string; enabled: boolean };

function namedFields<T extends NamedField>(
  value: unknown,
  extra: (rec: Record<string, unknown>, base: NamedField) => T,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const rec = asRecord(item);
    const name = asString(rec.name);
    if (name === "") {
      return [];
    }
    return [extra(rec, { name, value: asString(rec.value), enabled: rec.enabled !== false })];
  });
}

function paramsFromUnknown(value: unknown): HttpClientParam[] {
  return namedFields(value, (rec, base) => ({
    ...base,
    kind: asString(rec.type) === "path" ? "path" : "query",
  }));
}

function headersFromUnknown(value: unknown): HttpClientHeader[] {
  return namedFields(value, (_rec, base) => base);
}

function varsFromUnknown(value: unknown): HttpClientVar[] {
  const rec = asRecord(value);
  if (Array.isArray(rec.variables)) {
    return varsFromRecord(rec.variables);
  }
  return varsFromRecord(rec.req);
}

function varsFromRecord(value: unknown): HttpClientVar[] {
  return namedFields(value, (_rec, base) => base);
}

function bodyFromUnknown(value: unknown, modeHint: string): HttpClientBody {
  const rec = asRecord(value);
  const body = emptyHttpClientBody();
  const mode = normalizeBodyMode(modeHint || asString(rec.mode));
  body.mode = mode;
  body.text = firstString(rec.json, rec.text, rec.xml, rec.sparql);
  body.graphqlQuery = asString(asRecord(rec.graphql).query);
  body.graphqlVariables = asString(asRecord(rec.graphql).variables);
  body.form = formFromUnknown(mode === "multipart" ? rec.multipartForm : rec.formUrlEncoded);
  if (mode === "graphql" && body.graphqlQuery === "") {
    body.graphqlQuery = body.text;
  }
  if (mode === "json" && body.text === "" && typeof rec.json === "object" && rec.json !== null) {
    body.text = JSON.stringify(rec.json);
  }
  return body;
}

function formFromUnknown(value: unknown): HttpClientFormField[] {
  return namedFields(value, (_rec, base) => base);
}

function authFromUnknown(value: unknown, modeHint: string): HttpClientAuth {
  const rec = asRecord(value);
  const auth = emptyHttpClientAuth();
  auth.mode = normalizeAuthMode(modeHint || asString(rec.mode));
  const bearer = asRecord(rec.bearer);
  const basic = asRecord(rec.basic);
  const apikey = asRecord(rec.apikey) ?? asRecord(rec.apiKey);
  auth.token = asString(bearer.token);
  auth.username = asString(basic.username);
  auth.password = asString(basic.password);
  auth.key = asString(apikey.key);
  auth.value = asString(apikey.value);
  auth.placement = asString(apikey.placement) === "query" ? "query" : "header";
  return auth;
}

function normalizeBodyMode(mode: string): HttpClientBodyMode {
  const value = mode.toLowerCase();
  if (value === "json" || value === "text" || value === "xml" || value === "graphql") {
    return value;
  }
  if (value === "form-urlencoded" || value === "formurlencoded" || value === "form") {
    return "form";
  }
  if (value === "multipart-form" || value === "multipartform" || value === "multipart") {
    return "multipart";
  }
  if (value === "sparql") {
    return "xml";
  }
  return value === "none" || value === "" ? "none" : "text";
}

function normalizeAuthMode(mode: string): HttpClientAuthMode {
  const value = mode.toLowerCase();
  if (value === "bearer" || value === "basic" || value === "inherit" || value === "apikey" || value === "devctl") {
    return value;
  }
  if (value === "api-key" || value === "apikey") {
    return "apikey";
  }
  return "none";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return "";
}

export function folderItem(id: string, name: string, items: CollectionItem[], vars: HttpClientVar[], auth: HttpClientAuth, headers: HttpClientHeader[]): CollectionItem {
  return { kind: "folder", id, name, items, vars, headers, auth };
}

export function requestItem(request: HttpClientRequest): CollectionItem {
  return { kind: "request", id: request.id, request };
}
