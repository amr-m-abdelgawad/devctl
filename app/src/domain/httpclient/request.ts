import { emptyRouteAuth, type RouteAuthConfig } from "../config/types.ts";

export type HttpClientParamKind = "query" | "path";

export type HttpClientParam = {
  name: string;
  value: string;
  enabled: boolean;
  kind: HttpClientParamKind;
};

export type HttpClientHeader = {
  name: string;
  value: string;
  enabled: boolean;
};

export type HttpClientBodyMode = "none" | "json" | "text" | "form" | "multipart" | "graphql" | "xml";

export type HttpClientFormField = {
  name: string;
  value: string;
  enabled: boolean;
};

export type HttpClientBody = {
  mode: HttpClientBodyMode;
  text: string;
  form: HttpClientFormField[];
  graphqlQuery: string;
  graphqlVariables: string;
};

export type HttpClientAuthMode = "none" | "inherit" | "bearer" | "basic" | "apikey" | "devctl";

export type HttpClientAuth = {
  mode: HttpClientAuthMode;
  token: string;
  username: string;
  password: string;
  key: string;
  value: string;
  placement: "header" | "query";
  /** Present when this request should mint a devctl identity token. */
  devctl: RouteAuthConfig;
};

export type HttpClientVar = {
  name: string;
  value: string;
  enabled: boolean;
};

export type HttpClientRequest = {
  id: string;
  name: string;
  method: string;
  url: string;
  params: HttpClientParam[];
  headers: HttpClientHeader[];
  body: HttpClientBody;
  auth: HttpClientAuth;
  vars: HttpClientVar[];
  timeoutSeconds: number;
};

export type HttpClientResponse = {
  status: number;
  statusText: string;
  headers: HttpClientHeader[];
  body: string;
  size: number;
  durationMs: number;
  truncated: boolean;
};

export type HttpClientFolder = {
  kind: "folder";
  id: string;
  name: string;
  items: CollectionItem[];
  vars: HttpClientVar[];
  headers: HttpClientHeader[];
  auth: HttpClientAuth;
};

export type HttpClientRequestItem = {
  kind: "request";
  id: string;
  request: HttpClientRequest;
};

export type CollectionItem = HttpClientFolder | HttpClientRequestItem;

export type HttpClientEnvironment = {
  id: string;
  name: string;
  vars: HttpClientVar[];
};

export type HttpClientCollectionSource = "bruno" | "devctl";

export type HttpClientCollection = {
  id: string;
  name: string;
  source: HttpClientCollectionSource;
  path: string;
  readonly: boolean;
  vars: HttpClientVar[];
  headers: HttpClientHeader[];
  auth: HttpClientAuth;
  items: CollectionItem[];
  environments: HttpClientEnvironment[];
};

export type HttpClientSendInput = {
  collectionId?: string;
  requestId?: string;
  inline?: HttpClientRequest;
  env?: string;
  profile?: string;
  vars?: Record<string, string>;
  insecureAttachToken?: boolean;
};

export type HttpClientCollectionSummary = {
  id: string;
  name: string;
  source: HttpClientCollectionSource;
  readonly: boolean;
  requestCount: number;
};

export type HttpClientTreeRow = {
  depth: number;
  kind: "collection" | "folder" | "request";
  id: string;
  collectionId: string;
  requestId?: string;
  name: string;
  method?: string;
  readonly: boolean;
};

export const DEFAULT_HTTP_CLIENT_TIMEOUT_SECONDS = 30;
export const VIRTUAL_COLLECTION_ID = "devctl";
export const HTTP_CLIENT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export type HttpClientMethod = (typeof HTTP_CLIENT_METHODS)[number];

export function parseRequestRef(ref: string): { collectionId: string; requestId: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  return { collectionId: trimmed.slice(0, slash), requestId: trimmed.slice(slash + 1) };
}

export function prettyHttpBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return body;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown, null, 2);
  } catch {
    return body;
  }
}

export function flattenCollections(collections: readonly HttpClientCollection[]): HttpClientTreeRow[] {
  return collections.flatMap((collection) => flattenTree(collection));
}

export function emptyHttpClientBody(): HttpClientBody {
  return { mode: "none", text: "", form: [], graphqlQuery: "", graphqlVariables: "" };
}

export function emptyHttpClientAuth(): HttpClientAuth {
  return {
    mode: "none",
    token: "",
    username: "",
    password: "",
    key: "",
    value: "",
    placement: "header",
    devctl: emptyRouteAuth(),
  };
}

export function emptyHttpClientRequest(): HttpClientRequest {
  return {
    id: "",
    name: "",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: emptyHttpClientBody(),
    auth: emptyHttpClientAuth(),
    vars: [],
    timeoutSeconds: 0,
  };
}

export function cloneHttpClientRequest(request: HttpClientRequest): HttpClientRequest {
  return {
    ...request,
    params: request.params.map((item) => ({ ...item })),
    headers: request.headers.map((item) => ({ ...item })),
    body: {
      ...request.body,
      form: request.body.form.map((item) => ({ ...item })),
    },
    auth: { ...request.auth, devctl: { ...request.auth.devctl, identity: { ...request.auth.devctl.identity }, headers: { ...request.auth.devctl.headers } } },
    vars: request.vars.map((item) => ({ ...item })),
  };
}

export function requestCount(items: readonly CollectionItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.kind === "request") {
      count += 1;
    } else {
      count += requestCount(item.items);
    }
  }
  return count;
}

export function findRequest(items: readonly CollectionItem[], id: string): HttpClientRequest | undefined {
  for (const item of items) {
    if (item.kind === "request") {
      if (item.id === id || item.request.id === id || item.request.name === id) {
        return item.request;
      }
    } else {
      const nested = findRequest(item.items, id);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

export function folderChain(items: readonly CollectionItem[], requestId: string, parents: HttpClientFolder[] = []): HttpClientFolder[] | undefined {
  for (const item of items) {
    if (item.kind === "request") {
      if (item.id === requestId || item.request.id === requestId || item.request.name === requestId) {
        return parents;
      }
    } else {
      const found = folderChain(item.items, requestId, [...parents, item]);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export function flattenTree(collection: HttpClientCollection): HttpClientTreeRow[] {
  const rows: HttpClientTreeRow[] = [{
    depth: 0,
    kind: "collection",
    id: collection.id,
    collectionId: collection.id,
    name: collection.name,
    readonly: collection.readonly,
  }];
  walkItems(collection.items, collection.id, collection.readonly, 1, rows);
  return rows;
}

function walkItems(
  items: readonly CollectionItem[],
  collectionId: string,
  readonly: boolean,
  depth: number,
  rows: HttpClientTreeRow[],
): void {
  for (const item of items) {
    if (item.kind === "folder") {
      rows.push({
        depth,
        kind: "folder",
        id: `${collectionId}/${item.id}`,
        collectionId,
        name: item.name,
        readonly,
      });
      walkItems(item.items, collectionId, readonly, depth + 1, rows);
    } else {
      rows.push({
        depth,
        kind: "request",
        id: `${collectionId}/${item.request.id}`,
        collectionId,
        requestId: item.request.id,
        name: item.request.name,
        method: item.request.method,
        readonly,
      });
    }
  }
}

export function collectionSummary(collection: HttpClientCollection): HttpClientCollectionSummary {
  return {
    id: collection.id,
    name: collection.name,
    source: collection.source,
    readonly: collection.readonly,
    requestCount: requestCount(collection.items),
  };
}
