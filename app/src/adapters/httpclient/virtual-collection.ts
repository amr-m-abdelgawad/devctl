import {
  emptyHttpRequest,
  type DevctlConfig,
  type HttpRequestConfig,
  type RouteAuthConfig,
} from "../../domain/config/types.ts";
import {
  VIRTUAL_COLLECTION_ID,
  cloneHttpClientRequest,
  emptyHttpClientAuth,
  emptyHttpClientBody,
  emptyHttpClientRequest,
  type HttpClientAuth,
  type HttpClientCollection,
  type HttpClientRequest,
} from "../../domain/httpclient/request.ts";
import { requestItem } from "./bru.ts";
import { identityToRouteAuth } from "./identity-map.ts";

export function virtualDevctlCollection(cfg: DevctlConfig): HttpClientCollection {
  const items = [
    ...Object.keys(cfg.services).sort().map((name) => requestItem(serviceRequest(name, cfg))),
    ...Object.keys(cfg.http).sort().map((name) => requestItem(recipeRequest(name, cfg))),
  ];
  return {
    id: VIRTUAL_COLLECTION_ID,
    name: "devctl",
    source: "devctl",
    path: "",
    readonly: true,
    vars: [],
    headers: [],
    auth: emptyHttpClientAuth(),
    items,
    environments: [],
  };
}

function serviceRequest(name: string, cfg: DevctlConfig): HttpClientRequest {
  const req = cloneHttpClientRequest(emptyHttpClientRequest());
  req.id = `service:${name}`;
  req.name = name;
  req.method = "GET";
  req.url = `\${services.${name}.url}`;
  req.auth = {
    ...emptyHttpClientAuth(),
    mode: "devctl",
    devctl: identityToRouteAuth(cfg.services[name]?.identity),
  };
  return req;
}

function recipeRequest(name: string, cfg: DevctlConfig): HttpClientRequest {
  const recipe = cfg.http[name];
  const source = recipe?.request ?? emptyHttpRequest();
  return fromHttpRequestConfig(`recipe:${name}`, name, source);
}

export function fromHttpRequestConfig(id: string, name: string, source: HttpRequestConfig): HttpClientRequest {
  const req = emptyHttpClientRequest();
  req.id = id;
  req.name = name;
  req.method = (source.method || "GET").toUpperCase();
  req.url = source.url;
  req.headers = Object.entries(source.headers).map(([headerName, value]) => ({
    name: headerName,
    value,
    enabled: true,
  }));
  req.timeoutSeconds = source.timeout_seconds;
  req.auth = routeAuthToHttpClient(source.auth);
  const formKeys = Object.keys(source.form);
  if (formKeys.length > 0) {
    req.body = {
      ...emptyHttpClientBody(),
      mode: "form",
      form: formKeys.map((key) => ({ name: key, value: source.form[key] ?? "", enabled: true })),
    };
    return req;
  }
  if (source.body !== "") {
    const trimmed = source.body.trim();
    const json = trimmed.startsWith("{") || trimmed.startsWith("[");
    req.body = { ...emptyHttpClientBody(), mode: json ? "json" : "text", text: source.body };
  }
  return req;
}

function routeAuthToHttpClient(auth: RouteAuthConfig): HttpClientAuth {
  const type = auth.type.toLowerCase();
  if (type === "" || type === "none") {
    return emptyHttpClientAuth();
  }
  return {
    ...emptyHttpClientAuth(),
    mode: "devctl",
    devctl: { ...auth, identity: { ...auth.identity }, headers: { ...auth.headers } },
  };
}
