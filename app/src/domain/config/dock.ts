import { isLoopbackHostname } from "../net/hosts.ts";
import { namedPort, type DevctlConfig, type WebDockItem } from "./types.ts";

export const DOCK_KIND_IFRAME = "iframe";
export const DOCK_KIND_TEXT = "text";
export const DOCK_MAX_ITEMS = 8;
export const DOCK_MAX_TITLE_LENGTH = 80;
export const DOCK_MAX_PATH_LENGTH = 512;
export const DOCK_MAX_TEXT_CHARS = 48_000;
export const DOCK_DEFAULT_REFRESH_SECONDS = 15;
export const DOCK_MIN_REFRESH_SECONDS = 5;
export const DOCK_MAX_REFRESH_SECONDS = 3600;
export const DOCK_FETCH_TIMEOUT_MS = 4_000;

const DOCK_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HTTP_PORT = 80;
const HTTPS_PORT = 443;

export type DockTarget = {
  url: string;
  error: string;
};

export function dockConfigIssues(cfg: DevctlConfig): string[] {
  const issues: string[] = [];
  if (cfg.web.dock.length > DOCK_MAX_ITEMS) {
    issues.push(`web.dock lists ${cfg.web.dock.length} items; the maximum is ${DOCK_MAX_ITEMS}`);
  }
  const seen = new Set<string>();
  for (const [index, item] of cfg.web.dock.entries()) {
    issues.push(...dockItemIssues(cfg, item, index, seen));
  }
  return issues;
}

export function resolveDockTarget(
  item: WebDockItem,
  cfg: DevctlConfig,
  assigned: Record<string, Record<string, number>>,
  consolePort: number,
): DockTarget {
  if (item.url.trim() !== "") {
    return targetFromUrl(item.url.trim(), consolePort);
  }
  return targetFromService(item, cfg, assigned, consolePort);
}

export function dockRefreshSeconds(item: WebDockItem): number {
  if (item.kind !== DOCK_KIND_TEXT || item.refresh_seconds === 0) {
    return DOCK_DEFAULT_REFRESH_SECONDS;
  }
  return item.refresh_seconds;
}

export function dockSourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port === "" ? "" : `:${parsed.port}`;
    return `${parsed.hostname}${port}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Pretty-print JSON, flatten HTML to text, and leave other text bodies alone. */
export function formatDockText(contentType: string, body: string): string {
  const type = contentType.toLowerCase();
  const text = body.replace(/^\uFEFF/, "");
  if (type.includes("html")) {
    return htmlToText(text);
  }
  if (type.includes("json") || looksLikeJson(text)) {
    return prettyJson(text);
  }
  if (looksLikeHtml(text)) {
    return htmlToText(text);
  }
  return text;
}

/** Rewrite the name `localhost` to 127.0.0.1 so a text fetch cannot leave loopback via DNS. */
export function loopbackFetchUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.hostname === "localhost") {
    parsed.hostname = "127.0.0.1";
  }
  return parsed.toString();
}

function dockItemIssues(cfg: DevctlConfig, item: WebDockItem, index: number, seen: Set<string>): string[] {
  const prefix = `web.dock[${index}]`;
  return [
    ...identityIssues(prefix, item, seen),
    ...kindIssues(prefix, item),
    ...sourceIssues(cfg, prefix, item),
    ...refreshIssues(prefix, item),
  ];
}

function identityIssues(prefix: string, item: WebDockItem, seen: Set<string>): string[] {
  const issues: string[] = [];
  if (!DOCK_ID.test(item.id)) {
    issues.push(`${prefix}.id must be a short lowercase name (letters, digits, _ or -)`);
  } else if (seen.has(item.id)) {
    issues.push(`${prefix}.id "${item.id}" is duplicated`);
  } else {
    seen.add(item.id);
  }
  const title = item.title.trim();
  if (title === "" || title.length > DOCK_MAX_TITLE_LENGTH || title.includes("\n")) {
    issues.push(`${prefix}.title is required and must be a single line up to ${DOCK_MAX_TITLE_LENGTH} characters`);
  }
  return issues;
}

function kindIssues(prefix: string, item: WebDockItem): string[] {
  if (item.kind === DOCK_KIND_IFRAME || item.kind === DOCK_KIND_TEXT) {
    return [];
  }
  return [`${prefix}.kind must be iframe or text`];
}

function refreshIssues(prefix: string, item: WebDockItem): string[] {
  if (item.refresh_seconds === 0) {
    return [];
  }
  if (item.kind !== DOCK_KIND_TEXT) {
    return [`${prefix}.refresh_seconds applies to kind: text`];
  }
  const value = item.refresh_seconds;
  if (!Number.isInteger(value) || value < DOCK_MIN_REFRESH_SECONDS || value > DOCK_MAX_REFRESH_SECONDS) {
    return [`${prefix}.refresh_seconds must be an integer from ${DOCK_MIN_REFRESH_SECONDS} to ${DOCK_MAX_REFRESH_SECONDS}`];
  }
  return [];
}

function sourceIssues(cfg: DevctlConfig, prefix: string, item: WebDockItem): string[] {
  const hasUrl = item.url !== "";
  const hasService = item.service !== "";
  if (hasUrl === hasService) {
    return [`${prefix} needs exactly one of url or service`];
  }
  if (hasUrl) {
    return urlIssues(cfg, prefix, item.url);
  }
  return serviceIssues(cfg, prefix, item);
}

function urlIssues(cfg: DevctlConfig, prefix: string, raw: string): string[] {
  if (raw.includes("${")) {
    return [`${prefix}.url must be a literal loopback address; use service to follow a managed port`];
  }
  const parsed = parseLoopbackHttp(raw);
  if (typeof parsed === "string") {
    return [`${prefix}.url ${parsed}`];
  }
  if (targetsConsole(parsed, cfg.web.listen.port)) {
    return [`${prefix}.url must not target the web console`];
  }
  return [];
}

function serviceIssues(cfg: DevctlConfig, prefix: string, item: WebDockItem): string[] {
  const svc = cfg.services[item.service];
  if (!svc) {
    return [`${prefix}.service "${item.service}" is not a configured service`];
  }
  const issues: string[] = [];
  const portName = item.port || "http";
  const spec = namedPort(svc.ports, portName);
  if (!spec) {
    issues.push(`${prefix}.port "${portName}" is not declared on ${item.service}`);
  } else if (!spec.auto && spec.value === cfg.web.listen.port && cfg.web.listen.port !== 0) {
    issues.push(`${prefix} must not target the web console port`);
  }
  const pathProblem = dockPathIssue(item.path);
  if (pathProblem) {
    issues.push(`${prefix}.path ${pathProblem}`);
  }
  return issues;
}

function dockPathIssue(path: string): string | undefined {
  if (path === "") {
    return undefined;
  }
  if (path.length > DOCK_MAX_PATH_LENGTH || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /\s/.test(path)) {
    return "must be a single URL path starting with /";
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "is not a valid URL path";
  }
  if (decoded.split("/").includes("..")) {
    return "must not contain ..";
  }
  return undefined;
}

function targetFromUrl(raw: string, consolePort: number): DockTarget {
  const parsed = parseLoopbackHttp(raw);
  if (typeof parsed === "string") {
    return { url: "", error: parsed };
  }
  if (targetsConsole(parsed, consolePort)) {
    return { url: "", error: "refusing to load the web console inside the dock" };
  }
  return { url: parsed.toString(), error: "" };
}

function targetFromService(
  item: WebDockItem,
  cfg: DevctlConfig,
  assigned: Record<string, Record<string, number>>,
  consolePort: number,
): DockTarget {
  const svc = cfg.services[item.service];
  const portName = item.port || "http";
  if (!svc) {
    return { url: "", error: `unknown service ${item.service}` };
  }
  const spec = namedPort(svc.ports, portName);
  const live = assigned[item.service]?.[portName];
  const port = live ?? (spec && !spec.auto ? spec.value : undefined);
  if (port === undefined) {
    return { url: "", error: `${item.service} is not listening on ${portName}` };
  }
  const path = item.path || "/";
  const pathProblem = dockPathIssue(path);
  if (pathProblem) {
    return { url: "", error: pathProblem };
  }
  return targetFromUrl(`http://127.0.0.1:${port}${path}`, consolePort);
}

function parseLoopbackHttp(raw: string): URL | string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "must be an absolute http(s) URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "must use http or https";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "must not include credentials";
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    return "must use a loopback host (127.0.0.1, localhost, or ::1)";
  }
  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return "has an invalid port";
    }
  }
  return parsed;
}

function targetsConsole(url: URL, consolePort: number): boolean {
  if (consolePort === 0 || !isLoopbackHostname(url.hostname)) {
    return false;
  }
  const port = url.port === "" ? (url.protocol === "https:" ? HTTPS_PORT : HTTP_PORT) : Number(url.port);
  return port === consolePort;
}

function looksLikeJson(text: string): boolean {
  const start = text.trimStart()[0];
  return start === "{" || start === "[";
}

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<") && trimmed.includes(">");
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const withBreaks = withoutNoise
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, "");
  return decodeEntities(stripped).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}
