export type TokenGateDecision = "attach" | "skip" | "prompt";

export type TokenGateInput = {
  url: string;
  knownHosts: readonly string[];
  allowlist: readonly string[];
  insecureAttach: boolean;
};

export type UrlHost = {
  protocol: string;
  host: string;
  port: string;
};

const LOCALHOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);
const HTTP_DEFAULT_PORT = "80";
const HTTPS_DEFAULT_PORT = "443";

export function parseUrlHost(url: string): UrlHost | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const host = normalizeHost(parsed.hostname);
    if (host === "") {
      return undefined;
    }
    const port = parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? HTTPS_DEFAULT_PORT : HTTP_DEFAULT_PORT;
    return { protocol: parsed.protocol, host, port };
  } catch {
    return undefined;
  }
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  if (LOCALHOST_ALIASES.has(trimmed)) {
    return "127.0.0.1";
  }
  return trimmed;
}

function hostKey(host: UrlHost): string {
  return `${host.host}:${host.port}`;
}

function patternHost(pattern: string): UrlHost | undefined {
  const trimmed = pattern.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed.includes("://")) {
    return parseUrlHost(trimmed);
  }
  const withScheme = trimmed.includes("/") ? `http://${trimmed}` : `http://${trimmed}`;
  return parseUrlHost(withScheme);
}

function matchesKnown(target: UrlHost, pattern: string): boolean {
  const parsed = patternHost(pattern);
  if (!parsed) {
    return normalizeHost(pattern) === target.host;
  }
  if (parsed.host !== target.host) {
    return false;
  }
  const patternHadExplicitPort = pattern.includes("://")
    ? (() => {
      try {
        return new URL(pattern).port !== "";
      } catch {
        return false;
      }
    })()
    : /:\d+$/.test(pattern.trim());
  if (!patternHadExplicitPort) {
    return true;
  }
  return parsed.port === target.port;
}

function matchesKnownExact(target: UrlHost, pattern: string): boolean {
  const parsed = patternHost(pattern);
  if (!parsed) {
    const key = pattern.includes(":") ? pattern : `${pattern}:${target.port}`;
    const [hostPart, portPart] = key.split(":");
    return normalizeHost(hostPart ?? "") === target.host && (portPart ?? target.port) === target.port;
  }
  return hostKey(parsed) === hostKey(target);
}

export function tokenGate(input: TokenGateInput): TokenGateDecision {
  if (input.insecureAttach) {
    return "attach";
  }
  const target = parseUrlHost(input.url);
  if (!target) {
    return "skip";
  }
  for (const known of input.knownHosts) {
    if (matchesKnownExact(target, known)) {
      return "attach";
    }
  }
  for (const allowed of input.allowlist) {
    if (matchesKnown(target, allowed)) {
      return "attach";
    }
  }
  return "skip";
}
