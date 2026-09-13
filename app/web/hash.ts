import type { Route, RouteName } from "./types.ts";

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  const parts = path.split("/").filter((part) => part !== "");
  const head = parts[0] ?? "services";
  if (head === "traces") {
    return { name: "traces", traceId: parts[1] };
  }
  if (head === "graph" || head === "logs" || head === "services") {
    return { name: head };
  }
  return { name: "services" };
}

export function hrefFor(name: RouteName, traceId?: string): string {
  if (name === "traces" && traceId) {
    return `#/traces/${traceId}`;
  }
  return `#/${name}`;
}
