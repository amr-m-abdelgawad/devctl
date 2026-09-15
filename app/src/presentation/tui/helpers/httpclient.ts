import type { ChipTone } from "../layout.tsx";
import type { HttpClientTreeRow } from "../../../domain/httpclient/request.ts";

export const HTTP_REQUEST_TABS = ["params", "headers", "body", "auth", "vars"] as const;
export const HTTP_RESPONSE_TABS = ["body", "headers"] as const;
export const HTTP_PANES = ["tree", "request", "response"] as const;

export type HttpRequestTab = (typeof HTTP_REQUEST_TABS)[number];
export type HttpResponseTab = (typeof HTTP_RESPONSE_TABS)[number];
export type HttpPane = (typeof HTTP_PANES)[number];
export type HttpInputField = "" | "url" | "body" | "filter";

export function methodTone(method: string): ChipTone {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") {
    return "success";
  }
  if (upper === "POST") {
    return "warning";
  }
  if (upper === "DELETE") {
    return "error";
  }
  if (upper === "PUT" || upper === "PATCH") {
    return "info";
  }
  return "muted";
}

export function filterHttpTree(rows: readonly HttpClientTreeRow[], query: string): HttpClientTreeRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...rows];
  }
  return rows.filter((row) => {
    const hay = `${row.name} ${row.method ?? ""} ${row.requestId ?? ""} ${row.collectionId}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function nextTab<T extends string>(tabs: readonly T[], current: T, dir: number): T {
  const index = tabs.indexOf(current);
  const next = (index + dir + tabs.length) % tabs.length;
  return tabs[next] ?? current;
}

export function nextPane(current: HttpPane, dir: number): HttpPane {
  return nextTab(HTTP_PANES, current, dir);
}

export function formatByteSize(size: number): string {
  if (size < 1024) {
    return `${size}b`;
  }
  return `${(size / 1024).toFixed(1)}kb`;
}
