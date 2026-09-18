import type { Route, RouteName } from "./types.ts";

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  const parts = path.split("/").filter((part) => part !== "");
  const head = parts[0] ?? "services";
  if (head === "traces") {
    return { name: "traces", traceId: decodeHashId(parts[1]) };
  }
  if (head === "llm") {
    return { name: "llm", llmId: decodeHashId(parts[1]) };
  }
  if (head === "traffic") {
    return { name: "traffic", trafficId: decodeHashId(parts[1]) };
  }
  if (head === "graph" || head === "logs" || head === "services") {
    return { name: head };
  }
  return { name: "services" };
}

export function hrefFor(name: RouteName, id?: string): string {
  if ((name === "traces" || name === "llm" || name === "traffic") && id) {
    return `#/${name}/${encodeURIComponent(id)}`;
  }
  return `#/${name}`;
}

export function activeInspectId(pinnedId: string | undefined, newestId: string | undefined): string | undefined {
  return pinnedId || newestId;
}

export function setInspectHash(name: Extract<RouteName, "llm" | "traffic" | "traces">, id: string): void {
  const next = hrefFor(name, id);
  if (window.location.hash !== next) {
    window.location.hash = next;
  }
}

function decodeHashId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
