import {
  httpClientBodyMaxBytes,
  type DevctlConfig,
  type RouteAuthConfig,
} from "../../domain/config/types.ts";
import {
  DEFAULT_HTTP_CLIENT_TIMEOUT_SECONDS,
  cloneHttpClientRequest,
  folderChain,
  type HttpClientAuth,
  type HttpClientCollection,
  type HttpClientHeader,
  type HttpClientParam,
  type HttpClientRequest,
  type HttpClientResponse,
  type HttpClientSendInput,
} from "../../domain/httpclient/request.ts";
import { interpolateHttpClient } from "../../domain/httpclient/interpolate.ts";
import { mergeVars } from "../../domain/httpclient/vars.ts";
import { tokenGate } from "../../domain/httpclient/token-gate.ts";
import { profileEnvironment } from "../../domain/service/services.ts";
import { resolveString } from "../config/refs.ts";
import { assignedPorts } from "../http/assigned-ports.ts";
import { headerHasAuthorization, mintAuthToken } from "../http/identity.ts";
import { authorizedSend, type AuthorizedFetch } from "../http/send.ts";
import type { TokenManager } from "../google/token.ts";
import type { HttpClientSendResult } from "../../ports/http-client.ts";
import { identityToRouteAuth, routeAuthMints } from "./identity-map.ts";
import { knownServiceHosts, serviceNameForUrl } from "./origins.ts";

const MS_PER_SECOND = 1000;
const GET = "GET";
const HEAD = "HEAD";

export type ExecuteDeps = {
  cfg: DevctlConfig;
  tokens: TokenManager;
  userEmail: string;
  livePorts: Map<string, Record<string, number>>;
  processEnv: NodeJS.ProcessEnv;
  fetch: AuthorizedFetch;
  signal?: AbortSignal;
};

export async function executeHttpClientRequest(
  collection: HttpClientCollection | undefined,
  source: HttpClientRequest,
  input: HttpClientSendInput,
  deps: ExecuteDeps,
): Promise<HttpClientSendResult> {
  const request = cloneHttpClientRequest(source);
  const folders = collection ? folderChain(collection.items, request.id) ?? [] : [];
  const selected = selectedVars(collection, deps.cfg, input);
  const vars = mergeVars({
    runtime: input.vars ?? {},
    request: request.vars,
    folders: folders.map((folder) => folder.vars),
    selected,
    collection: collection?.vars ?? [],
    processEnv: deps.processEnv,
  });
  const assigned = assignedPorts(deps.cfg, deps.livePorts);
  const interpolateUrl = (value: string): string => interpolateHttpClient(
    value,
    (text) => resolveString(text, deps.cfg, assigned, deps.userEmail, { processEnv: deps.processEnv }),
    vars,
  );
  const url = applyParams(interpolateUrl(request.url), request.params, interpolateUrl);
  const decision = tokenGate({
    url,
    knownHosts: knownServiceHosts(deps.cfg, deps.livePorts),
    allowlist: deps.cfg.httpclient.token_hosts,
    insecureAttach: input.insecureAttachToken === true,
  });
  const auth = resolveAuth(collection, request, folders);
  const mintAuth = decision === "attach" ? mintableAuth(auth, url, deps) : undefined;
  const token = mintAuth ? await mintAuthToken(mintAuth, deps.tokens) : undefined;
  const interpolate = (value: string): string => interpolateHttpClient(
    value,
    (text) => resolveString(text, deps.cfg, assigned, deps.userEmail, { processEnv: deps.processEnv, token }),
    vars,
  );
  const headers = mergeHeaders(collection, folders, request, interpolate);
  applyBrunoAuth(headers, auth, interpolate);
  const body = encodeClientBody(request, interpolate, headers);
  const started = Date.now();
  const timeoutMs = (request.timeoutSeconds > 0 ? request.timeoutSeconds : DEFAULT_HTTP_CLIENT_TIMEOUT_SECONDS) * MS_PER_SECOND;
  const resp = await authorizedSend(
    { url, method: request.method || GET, headers, body, timeoutMs, signal: deps.signal },
    { token, extraHeaders: mintAuth?.headers },
    deps.fetch,
  );
  const raw = await resp.text();
  const cap = httpClientBodyMaxBytes(deps.cfg.httpclient);
  const size = byteLength(raw);
  const truncated = size > cap;
  const stored = truncated ? truncateUtf8(raw, cap) : raw;
  const durationMs = Date.now() - started;
  const response: HttpClientResponse = {
    status: resp.status,
    statusText: resp.statusText,
    headers: headersFromResponse(resp),
    body: stored,
    size,
    durationMs,
    truncated,
  };
  return {
    id: "",
    url,
    response,
    tokenDecision: decision,
    authAttached: token !== undefined,
  };
}

function selectedVars(
  collection: HttpClientCollection | undefined,
  cfg: DevctlConfig,
  input: HttpClientSendInput,
): Record<string, string> {
  if (input.profile && cfg.profiles[input.profile]) {
    return { ...profileEnvironment(cfg, input.profile) };
  }
  if (input.env && collection) {
    const env = collection.environments.find((item) => item.id === input.env || item.name === input.env);
    return Object.fromEntries((env?.vars ?? []).filter((item) => item.enabled).map((item) => [item.name, item.value]));
  }
  return {};
}

function resolveAuth(
  collection: HttpClientCollection | undefined,
  request: HttpClientRequest,
  folders: { auth: HttpClientAuth }[],
): HttpClientAuth {
  if (request.auth.mode !== "inherit") {
    return request.auth;
  }
  for (let index = folders.length - 1; index >= 0; index -= 1) {
    const auth = folders[index]?.auth;
    if (auth && auth.mode !== "none" && auth.mode !== "inherit") {
      return auth;
    }
  }
  return collection?.auth ?? request.auth;
}

function mintableAuth(auth: HttpClientAuth, url: string, deps: ExecuteDeps): RouteAuthConfig | undefined {
  if (auth.mode === "devctl" && routeAuthMints(auth.devctl)) {
    return auth.devctl;
  }
  const service = serviceNameForUrl(url, deps.cfg, deps.livePorts);
  if (!service) {
    return undefined;
  }
  const mapped = identityToRouteAuth(deps.cfg.services[service]?.identity);
  return routeAuthMints(mapped) ? mapped : undefined;
}

function mergeHeaders(
  collection: HttpClientCollection | undefined,
  folders: { headers: HttpClientHeader[] }[],
  request: HttpClientRequest,
  interpolate: (value: string) => string,
): Record<string, string> {
  const stacked: HttpClientHeader[] = [
    ...(collection?.headers ?? []),
    ...folders.flatMap((folder) => folder.headers),
    ...request.headers,
  ];
  const out: Record<string, string> = {};
  for (const header of stacked.filter((item) => item.enabled && item.name !== "")) {
    out[header.name] = interpolate(header.value);
  }
  return out;
}

function applyBrunoAuth(headers: Record<string, string>, auth: HttpClientAuth, interpolate: (value: string) => string): void {
  if (headerHasAuthorization(headers)) {
    return;
  }
  if (auth.mode === "bearer" && auth.token !== "") {
    headers.authorization = `Bearer ${interpolate(auth.token)}`;
    return;
  }
  if (auth.mode === "basic" && (auth.username !== "" || auth.password !== "")) {
    headers.authorization = `Basic ${btoa(`${interpolate(auth.username)}:${interpolate(auth.password)}`)}`;
    return;
  }
  if (auth.mode === "apikey" && auth.key !== "") {
    const value = interpolate(auth.value);
    if (auth.placement === "header") {
      headers[auth.key] = value;
    }
  }
}

function applyParams(url: string, params: HttpClientParam[], interpolate: (value: string) => string): string {
  let out = url;
  for (const param of params.filter((item) => item.enabled && item.kind === "path")) {
    out = out.replaceAll(`:${param.name}`, encodeURIComponent(interpolate(param.value)));
  }
  const query = params.filter((param) => param.enabled && param.kind === "query");
  if (query.length === 0) {
    return out;
  }
  const encoded = query.map((param) => `${encodeURIComponent(param.name)}=${encodeURIComponent(interpolate(param.value))}`).join("&");
  return out.includes("?") ? `${out}&${encoded}` : `${out}?${encoded}`;
}

function encodeClientBody(
  request: HttpClientRequest,
  interpolate: (value: string) => string,
  headers: Record<string, string>,
): string | undefined {
  const method = (request.method || GET).toUpperCase();
  if (method === GET || method === HEAD || request.body.mode === "none") {
    return undefined;
  }
  if (request.body.mode === "form") {
    const params = new URLSearchParams();
    for (const field of request.body.form) {
      if (field.enabled) {
        params.append(field.name, interpolate(field.value));
      }
    }
    if (!hasContentType(headers)) {
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    return params.toString();
  }
  if (request.body.mode === "graphql") {
    if (!hasContentType(headers)) {
      headers["content-type"] = "application/json";
    }
    const variables = interpolate(request.body.graphqlVariables || "{}");
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(variables) as unknown;
    } catch {
      parsed = {};
    }
    return JSON.stringify({ query: interpolate(request.body.graphqlQuery), variables: parsed });
  }
  const text = interpolate(request.body.text);
  if (text === "") {
    return undefined;
  }
  if (!hasContentType(headers) && request.body.mode === "json") {
    headers["content-type"] = "application/json";
  }
  if (!hasContentType(headers) && request.body.mode === "xml") {
    headers["content-type"] = "application/xml";
  }
  return text;
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
}

function headersFromResponse(resp: Response): HttpClientHeader[] {
  const out: HttpClientHeader[] = [];
  resp.headers.forEach((value, name) => {
    out.push({ name, value, enabled: true });
  });
  return out;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes));
}
