import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchHttpBody, fetchHttpCollection, fetchHttpCollections, fetchHttpResult, startHttpSend } from "../api.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Empty } from "../components/primitives.tsx";
import { cn } from "../lib/utils.ts";
import type {
  HttpCollection,
  HttpCollectionItem,
  HttpCollectionSummary,
  HttpHeader,
  HttpRequest,
  HttpSendResult,
  ProfileRow,
} from "../types.ts";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const REQUEST_TABS = ["Params", "Headers", "Body", "Auth", "Vars"] as const;
const RESPONSE_TABS = ["Body", "Headers"] as const;
const POLL_MS = 2000;

type RequestTab = (typeof REQUEST_TABS)[number];
type ResponseTab = (typeof RESPONSE_TABS)[number];

function emptyRequest(): HttpRequest {
  return {
    id: "inline",
    name: "Untitled",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: { mode: "none", text: "", form: [], graphqlQuery: "", graphqlVariables: "" },
    auth: { mode: "none", token: "", username: "", password: "", key: "", value: "", placement: "header" },
    vars: [],
    timeoutSeconds: 0,
  };
}

function cloneRequest(request: HttpRequest): HttpRequest {
  return {
    ...request,
    params: request.params.map((item) => ({ ...item })),
    headers: request.headers.map((item) => ({ ...item })),
    body: { ...request.body, form: request.body.form.map((item) => ({ ...item })) },
    auth: { ...request.auth },
    vars: request.vars.map((item) => ({ ...item })),
  };
}

function prettyBody(body: string): string {
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

function methodClass(method: string): string {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") {
    return "text-success";
  }
  if (upper === "POST") {
    return "text-warning";
  }
  if (upper === "DELETE") {
    return "text-destructive";
  }
  return "text-info";
}

function statusVariant(status: number): "success" | "warning" | "destructive" | "muted" {
  if (status >= 500) {
    return "destructive";
  }
  if (status >= 400) {
    return "warning";
  }
  if (status >= 200 && status < 300) {
    return "success";
  }
  return "muted";
}

type TreeRow = {
  id: string;
  depth: number;
  kind: "collection" | "folder" | "request";
  collectionId: string;
  requestId?: string;
  name: string;
  method?: string;
};

function walkItems(items: HttpCollectionItem[], collectionId: string, depth: number, rows: TreeRow[]): void {
  for (const item of items) {
    if (item.kind === "folder") {
      rows.push({ id: `${collectionId}/${item.id}`, depth, kind: "folder", collectionId, name: item.name });
      walkItems(item.items, collectionId, depth + 1, rows);
    } else {
      rows.push({
        id: `${collectionId}/${item.request.id}`,
        depth,
        kind: "request",
        collectionId,
        requestId: item.request.id,
        name: item.request.name,
        method: item.request.method,
      });
    }
  }
}

function findRequest(items: HttpCollectionItem[], id: string): HttpRequest | undefined {
  for (const item of items) {
    if (item.kind === "request" && (item.id === id || item.request.id === id || item.request.name === id)) {
      return item.request;
    }
    if (item.kind === "folder") {
      const nested = findRequest(item.items, id);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function FieldTable(props: {
  rows: Array<{ name: string; value: string; enabled?: boolean }>;
  nameLabel: string;
  onChange: (index: number, field: "name" | "value", value: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {props.rows.map((row, index) => (
        <div key={`${props.nameLabel}-${index}`} className="grid grid-cols-[1fr_2fr] gap-2">
          <input
            className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-xs"
            value={row.name}
            placeholder={props.nameLabel}
            onChange={(event) => props.onChange(index, "name", event.target.value)}
          />
          <input
            className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-xs"
            value={row.value}
            placeholder="value"
            onChange={(event) => props.onChange(index, "value", event.target.value)}
          />
        </div>
      ))}
      <Button type="button" size="xs" variant="ghost" onClick={props.onAdd}>Add {props.nameLabel.toLowerCase()}</Button>
    </div>
  );
}

export function HttpClientPage(props: { profiles: ProfileRow[]; profile: string }) {
  const [summaries, setSummaries] = useState<HttpCollectionSummary[]>([]);
  const [collections, setCollections] = useState<Record<string, HttpCollection>>({});
  const [selected, setSelected] = useState<{ collectionId: string; requestId?: string }>({ collectionId: "devctl" });
  const [draft, setDraft] = useState<HttpRequest>(emptyRequest);
  const [env, setEnv] = useState("");
  const [profile, setProfile] = useState(props.profile);
  const [requestTab, setRequestTab] = useState<RequestTab>("Params");
  const [responseTab, setResponseTab] = useState<ResponseTab>("Body");
  const [pendingId, setPendingId] = useState("");
  const [result, setResult] = useState<HttpSendResult | undefined>(undefined);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setProfile(props.profile);
  }, [props.profile]);

  const load = useCallback(async () => {
    const listed = await fetchHttpCollections();
    setSummaries(listed.collections);
    const loaded: Record<string, HttpCollection> = {};
    for (const summary of listed.collections) {
      loaded[summary.id] = await fetchHttpCollection(summary.id);
    }
    setCollections(loaded);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "failed to load collections");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const tree = useMemo(() => {
    const rows: TreeRow[] = [];
    const needle = filter.trim().toLowerCase();
    for (const summary of summaries) {
      const collection = collections[summary.id];
      rows.push({ id: summary.id, depth: 0, kind: "collection", collectionId: summary.id, name: summary.name });
      if (collection) {
        walkItems(collection.items, collection.id, 1, rows);
      }
    }
    if (needle === "") {
      return rows;
    }
    return rows.filter((row) => `${row.name} ${row.method ?? ""} ${row.requestId ?? ""}`.toLowerCase().includes(needle));
  }, [summaries, collections, filter]);

  useEffect(() => {
    const collection = collections[selected.collectionId];
    if (!collection || !selected.requestId) {
      return;
    }
    const request = findRequest(collection.items, selected.requestId);
    if (request) {
      setDraft(cloneRequest(request));
    }
  }, [collections, selected]);

  useEffect(() => {
    if (pendingId === "") {
      return;
    }
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const state = await fetchHttpResult(pendingId);
      if (cancelled) {
        return;
      }
      if (state.status === "pending") {
        return;
      }
      if (state.status === "ok") {
        const page = await fetchHttpBody(pendingId);
        if (cancelled) {
          return;
        }
        setResult({
          ...state.result,
          response: {
            ...state.result.response,
            body: page.body,
            size: page.size,
            truncated: page.truncated,
          },
        });
        setError("");
        setPendingId("");
        return;
      }
      setPendingId("");
      setError(state.status === "error" ? state.error : "request cancelled");
    };
    void poll().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "poll failed");
        setPendingId("");
      }
    });
    const timer = window.setInterval(() => {
      void poll().catch(() => undefined);
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingId]);

  const send = useCallback(async () => {
    setError("");
    setResult(undefined);
    try {
      const id = await startHttpSend({
        collectionId: selected.collectionId,
        requestId: selected.requestId,
        inline: draft,
        env: env || undefined,
        profile: profile || undefined,
      });
      setPendingId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    }
  }, [draft, env, profile, selected]);

  const collection = collections[selected.collectionId];
  const busy = pendingId !== "";

  return (
    <div className="flex min-h-[calc(100vh-7rem)] overflow-hidden">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border/70 bg-card/40">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Collections</p>
            <p className="text-sm font-medium text-foreground">HTTP client</p>
          </div>
          <Badge variant="muted">{summaries.length}</Badge>
        </div>
        <div className="px-3 py-2">
          <input
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
            placeholder="Filter requests"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
          {tree.length === 0 ? (
            <Empty>No Bruno collections or services yet.</Empty>
          ) : (
            tree.map((row) => {
              const active = row.kind === "request"
                ? selected.collectionId === row.collectionId && selected.requestId === row.requestId
                : selected.collectionId === row.collectionId && !selected.requestId && row.kind === "collection";
              return (
                <button
                  key={row.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px]",
                    active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                  style={{ paddingLeft: 8 + row.depth * 12 }}
                  onClick={() => setSelected({ collectionId: row.collectionId, requestId: row.requestId })}
                >
                  {row.method ? <span className={cn("w-12 shrink-0 font-mono text-[10px] font-semibold", methodClass(row.method))}>{row.method}</span> : <span className="w-12 shrink-0" />}
                  <span className="truncate">{row.name}</span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-card/30 px-4 py-2">
          <select
            className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs font-semibold"
            value={draft.method}
            onChange={(event) => setDraft({ ...draft, method: event.target.value })}
          >
            {METHODS.map((method) => (
              <option key={method} value={method}>{method}</option>
            ))}
            {METHODS.includes(draft.method as (typeof METHODS)[number]) ? null : <option value={draft.method}>{draft.method}</option>}
          </select>
          <input
            className="h-9 min-w-[16rem] flex-1 rounded-md border border-input bg-transparent px-3 font-mono text-sm"
            value={draft.url}
            placeholder="${services.api.url}/path or {{baseUrl}}/health"
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <select
            className="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
            value={env}
            onChange={(event) => setEnv(event.target.value)}
          >
            <option value="">Bruno env</option>
            {(collection?.environments ?? []).map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <select
            className="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            <option value="">devctl profile</option>
            {props.profiles.map((item) => (
              <option key={item.name} value={item.name}>{item.name}</option>
            ))}
          </select>
          <Button type="button" size="sm" disabled={busy || draft.url.trim() === ""} onClick={() => void send()}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(12rem,1fr)_minmax(14rem,1fr)]">
          <div className="flex min-h-0 flex-col border-b border-border/70">
            <div className="flex gap-1 px-4 pt-3">
              {REQUEST_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={cn("rounded-md px-2.5 py-1 text-[12px] font-medium", requestTab === tab ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
                  onClick={() => setRequestTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              {requestTab === "Params" ? (
                <FieldTable
                  nameLabel="Param"
                  rows={draft.params}
                  onChange={(index, field, value) => setDraft({ ...draft, params: draft.params.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)) })}
                  onAdd={() => setDraft({ ...draft, params: [...draft.params, { name: "", value: "", enabled: true, kind: "query" }] })}
                />
              ) : null}
              {requestTab === "Headers" ? (
                <FieldTable
                  nameLabel="Header"
                  rows={draft.headers}
                  onChange={(index, field, value) => setDraft({ ...draft, headers: draft.headers.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)) })}
                  onAdd={() => setDraft({ ...draft, headers: [...draft.headers, { name: "", value: "", enabled: true }] })}
                />
              ) : null}
              {requestTab === "Body" ? (
                <textarea
                  className="h-full min-h-[8rem] w-full resize-none rounded-md border border-input bg-transparent p-3 font-mono text-xs"
                  value={draft.body.mode === "graphql" ? draft.body.graphqlQuery : draft.body.text}
                  onChange={(event) => setDraft({
                    ...draft,
                    body: {
                      ...draft.body,
                      mode: draft.body.mode === "none" ? "json" : draft.body.mode,
                      text: draft.body.mode === "graphql" ? draft.body.text : event.target.value,
                      graphqlQuery: draft.body.mode === "graphql" ? event.target.value : draft.body.graphqlQuery,
                    },
                  })}
                  placeholder='{"ok":true}'
                />
              ) : null}
              {requestTab === "Auth" ? (
                <div className="grid max-w-xl grid-cols-[8rem_1fr] items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Mode</span>
                  <select
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                    value={draft.auth.mode}
                    onChange={(event) => setDraft({ ...draft, auth: { ...draft.auth, mode: event.target.value } })}
                  >
                    {["none", "inherit", "bearer", "basic", "apikey", "devctl"].map((mode) => (
                      <option key={mode} value={mode}>{mode}</option>
                    ))}
                  </select>
                  <span className="text-muted-foreground">Token</span>
                  <input
                    className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-xs"
                    value={draft.auth.token}
                    onChange={(event) => setDraft({ ...draft, auth: { ...draft.auth, token: event.target.value } })}
                  />
                </div>
              ) : null}
              {requestTab === "Vars" ? (
                <FieldTable
                  nameLabel="Var"
                  rows={draft.vars}
                  onChange={(index, field, value) => setDraft({ ...draft, vars: draft.vars.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)) })}
                  onAdd={() => setDraft({ ...draft, vars: [...draft.vars, { name: "", value: "", enabled: true }] })}
                />
              ) : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-col bg-muted/20">
            <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
              {RESPONSE_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={cn("rounded-md px-2.5 py-1 text-[12px] font-medium", responseTab === tab ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
                  onClick={() => setResponseTab(tab)}
                >
                  {tab}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                {result ? (
                  <>
                    <Badge variant={statusVariant(result.response.status)}>{result.response.status} {result.response.statusText}</Badge>
                    <span>{result.response.durationMs}ms</span>
                    <span>{result.response.size}b</span>
                    <span>{result.authAttached ? "token attached" : `token ${result.tokenDecision}`}</span>
                    {result.response.truncated ? <span>truncated</span> : null}
                  </>
                ) : (
                  <span>{busy ? "Waiting for response…" : "Response"}</span>
                )}
              </div>
            </div>
            {error ? <p className="px-4 py-2 text-xs text-destructive">{error}</p> : null}
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              {!result ? (
                <Empty>Send a request to inspect the response.</Empty>
              ) : responseTab === "Headers" ? (
                <HeaderBlock headers={result.response.headers} />
              ) : (
                <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-5 text-foreground">{prettyBody(result.response.body)}</pre>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function HeaderBlock(props: { headers: HttpHeader[] }) {
  if (props.headers.length === 0) {
    return <Empty>No headers</Empty>;
  }
  return (
    <dl className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
      {props.headers.map((header) => (
        <div key={`${header.name}:${header.value}`} className="contents">
          <dt className="text-muted-foreground">{header.name}</dt>
          <dd className="break-all text-foreground">{header.value}</dd>
        </div>
      ))}
    </dl>
  );
}
