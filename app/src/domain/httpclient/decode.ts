import {
  emptyHttpClientAuth,
  emptyHttpClientBody,
  emptyHttpClientRequest,
  type HttpClientAuthMode,
  type HttpClientBodyMode,
  type HttpClientFormField,
  type HttpClientHeader,
  type HttpClientParam,
  type HttpClientRequest,
  type HttpClientSendInput,
  type HttpClientVar,
} from "./request.ts";

export function asHttpSendInput(rec: Record<string, unknown>): HttpClientSendInput {
  return {
    collectionId: nonempty(rec.collectionId) ?? nonempty(rec.collection_id),
    requestId: nonempty(rec.requestId) ?? nonempty(rec.request_id),
    inline: rec.inline !== undefined ? asInlineRequest(rec.inline) : undefined,
    env: nonempty(rec.env),
    profile: nonempty(rec.profile),
    vars: asStringRecord(rec.vars),
    insecureAttachToken: rec.insecureAttachToken === true || rec.insecure_attach_token === true,
  };
}

function asInlineRequest(value: unknown): HttpClientRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const request = emptyHttpClientRequest();
  request.id = typeof value.id === "string" && value.id !== "" ? value.id : "inline";
  request.name = typeof value.name === "string" && value.name !== "" ? value.name : "inline";
  request.method = typeof value.method === "string" && value.method !== "" ? value.method.toUpperCase() : "GET";
  request.url = typeof value.url === "string" ? value.url : "";
  request.timeoutSeconds = asTimeout(value);
  request.params = asParams(value.params);
  request.headers = asHeaders(value.headers);
  request.body = asBody(value.body);
  request.auth = asAuth(value.auth);
  request.vars = asVars(value.vars);
  return request;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTimeout(value: Record<string, unknown>): number {
  if (typeof value.timeoutSeconds === "number") {
    return value.timeoutSeconds;
  }
  if (typeof value.timeout_seconds === "number") {
    return value.timeout_seconds;
  }
  return 0;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") {
      out[key] = val;
    }
  }
  return out;
}

function asNamedFields<T>(value: unknown, map: (name: string, item: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || item.name === "") {
      return [];
    }
    return [map(item.name, item)];
  });
}

function asParams(value: unknown): HttpClientParam[] {
  return asNamedFields(value, (name, item) => ({
    name,
    value: typeof item.value === "string" ? item.value : "",
    enabled: item.enabled !== false,
    kind: item.kind === "path" ? "path" : "query",
  }));
}

function asNamedList(value: unknown): Array<{ name: string; value: string; enabled: boolean }> {
  if (Array.isArray(value)) {
    return asNamedFields(value, (name, item) => ({
      name,
      value: typeof item.value === "string" ? item.value : "",
      enabled: item.enabled !== false,
    }));
  }
  const record = asStringRecord(value);
  if (!record) {
    return [];
  }
  return Object.entries(record).map(([name, fieldValue]) => ({ name, value: fieldValue, enabled: true }));
}

function asHeaders(value: unknown): HttpClientHeader[] {
  return asNamedList(value);
}

function asVars(value: unknown): HttpClientVar[] {
  return asNamedList(value);
}

function asForm(value: unknown): HttpClientFormField[] {
  return asNamedFields(value, (name, item) => ({
    name,
    value: typeof item.value === "string" ? item.value : "",
    enabled: item.enabled !== false,
  }));
}

function asBody(value: unknown): ReturnType<typeof emptyHttpClientBody> {
  if (typeof value === "string") {
    return { ...emptyHttpClientBody(), mode: "text", text: value };
  }
  if (!isRecord(value)) {
    return emptyHttpClientBody();
  }
  return {
    ...emptyHttpClientBody(),
    mode: asBodyMode(typeof value.mode === "string" ? value.mode : "none"),
    text: typeof value.text === "string" ? value.text : "",
    form: asForm(value.form),
    graphqlQuery: typeof value.graphqlQuery === "string" ? value.graphqlQuery : "",
    graphqlVariables: typeof value.graphqlVariables === "string" ? value.graphqlVariables : "",
  };
}

function asAuth(value: unknown): ReturnType<typeof emptyHttpClientAuth> {
  if (!isRecord(value)) {
    return emptyHttpClientAuth();
  }
  return {
    ...emptyHttpClientAuth(),
    mode: asAuthMode(typeof value.mode === "string" ? value.mode : "none"),
    token: typeof value.token === "string" ? value.token : "",
    username: typeof value.username === "string" ? value.username : "",
    password: typeof value.password === "string" ? value.password : "",
    key: typeof value.key === "string" ? value.key : "",
    value: typeof value.value === "string" ? value.value : "",
    placement: value.placement === "query" ? "query" : "header",
  };
}

function asBodyMode(mode: string): HttpClientBodyMode {
  if (mode === "json" || mode === "text" || mode === "form" || mode === "multipart" || mode === "graphql" || mode === "xml") {
    return mode;
  }
  return "none";
}

function asAuthMode(mode: string): HttpClientAuthMode {
  if (mode === "bearer" || mode === "basic" || mode === "apikey" || mode === "inherit" || mode === "devctl") {
    return mode;
  }
  return "none";
}
