import { useCallback, useEffect, useMemo, useState } from "react";
import type { Controller } from "../../../application/client-runtime.ts";
import {
  cloneHttpClientRequest,
  emptyHttpClientRequest,
  findRequest,
  flattenCollections,
  HTTP_CLIENT_METHODS,
  type HttpClientCollection,
  type HttpClientRequest,
} from "../../../domain/httpclient/request.ts";
import type { HttpClientSendResult } from "../../../ports/http-client.ts";
import { humanMessage } from "../../../shared/errors.ts";
import type { Screen } from "../types.ts";
import {
  filterHttpTree,
  HTTP_REQUEST_TABS,
  HTTP_RESPONSE_TABS,
  nextPane,
  nextTab,
  type HttpInputField,
  type HttpPane,
  type HttpRequestTab,
  type HttpResponseTab,
} from "../helpers/httpclient.ts";

type Options = {
  controller?: Controller;
  screen: Screen;
  selected: number;
  profile: string;
};

export function useHttpClientView(opts: Options) {
  const { controller, screen, selected, profile } = opts;
  const [collections, setCollections] = useState<HttpClientCollection[]>([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [pane, setPane] = useState<HttpPane>("tree");
  const [requestTab, setRequestTab] = useState<HttpRequestTab>("params");
  const [responseTab, setResponseTab] = useState<HttpResponseTab>("body");
  const [inputField, setInputField] = useState<HttpInputField>("");
  const [env, setEnv] = useState("");
  const [draft, setDraft] = useState<HttpClientRequest>(emptyHttpClientRequest);
  const [result, setResult] = useState<HttpClientSendResult | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    if (!controller) {
      return;
    }
    try {
      const listed = await controller.httpList();
      const next: HttpClientCollection[] = [];
      for (const summary of listed.collections) {
        next.push(await controller.httpCollection(summary.id));
      }
      setCollections(next);
      setError("");
    } catch (err) {
      setError(humanMessage(err));
    }
  }, [controller]);

  useEffect(() => {
    if (screen !== "httpclient" || !controller) {
      return;
    }
    void refresh();
  }, [screen, controller, refresh]);

  const tree = useMemo(() => filterHttpTree(flattenCollections(collections), filter), [collections, filter]);
  const index = tree.length === 0 ? 0 : Math.max(0, Math.min(selected, tree.length - 1));
  const row = tree[index];
  const collection = collections.find((item) => item.id === row?.collectionId);

  useEffect(() => {
    if (!row || row.kind !== "request" || !collection || !row.requestId) {
      return;
    }
    const request = findRequest(collection.items, row.requestId);
    if (request) {
      setDraft(cloneHttpClientRequest(request));
    }
  }, [row, collection]);

  const cycleEnv = useCallback(() => {
    const names = collection?.environments.map((item) => item.id) ?? [];
    if (names.length === 0) {
      setEnv("");
      return;
    }
    const index = names.indexOf(env);
    setEnv(names[(index + 1) % names.length] ?? "");
  }, [collection, env]);

  const cycleMethod = useCallback(() => {
    setDraft((current) => {
      const index = HTTP_CLIENT_METHODS.indexOf(current.method as (typeof HTTP_CLIENT_METHODS)[number]);
      const next = HTTP_CLIENT_METHODS[(index + 1) % HTTP_CLIENT_METHODS.length] ?? "GET";
      return { ...current, method: next };
    });
  }, []);

  const send = useCallback(async () => {
    if (!controller || sending) {
      return;
    }
    setSending(true);
    setError("");
    try {
      const raw = await controller.httpSend({
        collectionId: row?.collectionId,
        requestId: row?.requestId,
        inline: draft,
        env: env || undefined,
        profile: profile || undefined,
      }, true);
      if ("response" in raw) {
        setResult(raw);
      }
    } catch (err) {
      setError(humanMessage(err));
    } finally {
      setSending(false);
    }
  }, [controller, draft, env, profile, row, sending]);

  const beginEdit = useCallback((field: HttpInputField) => {
    setInputField(field);
    if (field === "body") {
      setRequestTab("body");
      setPane("request");
    }
    if (field === "url") {
      setPane("request");
    }
  }, []);

  return {
    collections,
    tree,
    error,
    filter,
    setFilter,
    pane,
    setPane,
    requestTab,
    setRequestTab,
    responseTab,
    setResponseTab,
    inputField,
    setInputField,
    env,
    draft,
    setDraft,
    result,
    sending,
    refresh,
    cycleEnv,
    cycleMethod,
    send,
    beginEdit,
    endEdit: () => setInputField(""),
    cyclePane: (dir: number) => setPane((current) => nextPane(current, dir)),
    cycleRequestTab: (dir: number) => setRequestTab((current) => nextTab(HTTP_REQUEST_TABS, current, dir)),
    cycleResponseTab: (dir: number) => setResponseTab((current) => nextTab(HTTP_RESPONSE_TABS, current, dir)),
    collection,
    row,
  };
}

export type HttpClientView = ReturnType<typeof useHttpClientView>;
