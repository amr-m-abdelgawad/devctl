import type { Route, RouteName } from "./types.ts";

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathname = "", query = ""] = raw.split("?");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const parts = path.split("/").filter((part) => part !== "");
  const head = parts[0] ?? "services";
  if (head === "services") {
    return { name: "services", serviceId: decodeHashId(parts[1]) };
  }
  if (head === "logs") {
    return { name: "logs", logService: new URLSearchParams(query).get("service") || undefined };
  }
  if (head === "traces") {
    return { name: "traces", traceId: decodeHashId(parts[1]) };
  }
  if (head === "llm") {
    return { name: "llm", llmId: decodeHashId(parts[1]) };
  }
  if (head === "traffic") {
    return { name: "traffic", trafficId: decodeHashId(parts[1]) };
  }
  if (
    head === "graph" ||
    head === "system" ||
    head === "workspace" ||
    head === "config" ||
    head === "proxy" ||
    head === "settings" ||
    head === "doctor" ||
    head === "identity"
  ) {
    return { name: head };
  }
  return { name: "services" };
}

export function hrefFor(name: RouteName, id?: string): string {
  if ((name === "traces" || name === "llm" || name === "traffic" || name === "services") && id) {
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
