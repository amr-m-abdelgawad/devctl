import { isLoopbackHostname } from "../net/hosts.ts";
import { namedPort, type DevctlConfig, type WebDockItem, type WebDockMetric } from "./types.ts";

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
export const DOCK_MAX_METRICS = 6;
export const DOCK_MAX_METRIC_KEY_LENGTH = 128;
export const DOCK_MAX_METRIC_LABEL_LENGTH = 40;
export const DOCK_MAX_METRIC_UNIT_LENGTH = 16;
export const DOCK_METRIC_STRING_LIMIT = 48;

const DOCK_METRIC_KEY = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9]\d*))*$/;
const DOCK_METRIC_INDEX = /^(?:0|[1-9]\d*)$/;
const DOCK_METRIC_FRACTION_DIGITS = 2;
const DOCK_METRIC_MISSING = "—";

const DOCK_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HTTP_PORT = 80;
const HTTPS_PORT = 443;

export type DockTarget = {
  url: string;
  error: string;
};

export type DockMetricReading = {
  key: string;
  label: string;
  value: string;
  unit: string;
  missing: boolean;
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

/** Read configured JSON keys. An array value becomes its length. A missing key or object is blank. */
export function extractDockMetrics(contentType: string, body: string, metrics: WebDockMetric[]): { readings: DockMetricReading[]; error: string } {
  if (metrics.length === 0) {
    return { readings: [], error: "" };
  }
  const parsed = parseMetricJson(contentType, body);
  if (!parsed.ok) {
    return { readings: metrics.map((metric) => blankMetric(metric)), error: "response is not JSON" };
  }
  return { readings: metrics.map((metric) => readMetric(parsed.value, metric)), error: "" };
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
    ...metricIssues(prefix, item),
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

function metricIssues(prefix: string, item: WebDockItem): string[] {
  if (item.metrics.length === 0) {
    return [];
  }
  if (item.kind !== DOCK_KIND_TEXT) {
    return [`${prefix}.metrics applies to kind: text`];
  }
  if (item.metrics.length > DOCK_MAX_METRICS) {
    return [`${prefix}.metrics lists ${item.metrics.length} keys; the maximum is ${DOCK_MAX_METRICS}`];
  }
  const seen = new Set<string>();
  return item.metrics.flatMap((metric, index) => oneMetricIssues(`${prefix}.metrics[${index}]`, metric, seen));
}

function oneMetricIssues(prefix: string, metric: WebDockMetric, seen: Set<string>): string[] {
  return [...metricKeyIssues(prefix, metric, seen), ...metricTextIssues(prefix, "label", metric.label, DOCK_MAX_METRIC_LABEL_LENGTH), ...metricUnitIssues(prefix, metric)];
}

function metricKeyIssues(prefix: string, metric: WebDockMetric, seen: Set<string>): string[] {
  if (metric.key.length > DOCK_MAX_METRIC_KEY_LENGTH || !DOCK_METRIC_KEY.test(metric.key)) {
    return [`${prefix}.key must be a dotted JSON key such as queued or stats.latency_ms`];
  }
  if (seen.has(metric.key)) {
    return [`${prefix}.key "${metric.key}" is duplicated`];
  }
  seen.add(metric.key);
  return [];
}

function metricTextIssues(prefix: string, field: "label", value: string, max: number): string[] {
  if (value.length > max || value.includes("\n")) {
    return [`${prefix}.${field} must be a single line up to ${max} characters`];
  }
  return [];
}

function metricUnitIssues(prefix: string, metric: WebDockMetric): string[] {
  if (metric.unit.length > DOCK_MAX_METRIC_UNIT_LENGTH || /\s/.test(metric.unit)) {
    return [`${prefix}.unit must be a short suffix with no spaces`];
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

function parseMetricJson(contentType: string, body: string): { ok: true; value: unknown } | { ok: false } {
  const text = body.replace(/^\uFEFF/, "");
  const type = contentType.toLowerCase();
  if (!type.includes("json") && !looksLikeJson(text)) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function readMetric(root: unknown, metric: WebDockMetric): DockMetricReading {
  const found = lookupMetric(root, metric.key);
  if (!found.ok) {
    return blankMetric(metric);
  }
  const formatted = formatMetricValue(found.value);
  return {
    key: metric.key,
    label: metricLabel(metric),
    value: formatted.value,
    unit: formatted.missing ? "" : metric.unit,
    missing: formatted.missing,
  };
}

function blankMetric(metric: WebDockMetric): DockMetricReading {
  return { key: metric.key, label: metricLabel(metric), value: DOCK_METRIC_MISSING, unit: "", missing: true };
}

function metricLabel(metric: WebDockMetric): string {
  const label = metric.label.trim();
  if (label !== "") {
    return label;
  }
  const last = metric.key.split(".").at(-1) ?? metric.key;
  const words = last.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lookupMetric(root: unknown, key: string): { ok: true; value: unknown } | { ok: false } {
  let current: unknown = root;
  for (const part of key.split(".")) {
    const next = stepMetric(current, part);
    if (!next.ok) {
      return next;
    }
    current = next.value;
  }
  return { ok: true, value: current };
}

function stepMetric(current: unknown, part: string): { ok: true; value: unknown } | { ok: false } {
  if (Array.isArray(current) && DOCK_METRIC_INDEX.test(part)) {
    const index = Number(part);
    if (index >= current.length) {
      return { ok: false };
    }
    return { ok: true, value: current[index] };
  }
  if (isPlainObject(current) && Object.hasOwn(current, part)) {
    return { ok: true, value: current[part] };
  }
  return { ok: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatMetricValue(value: unknown): { value: string; missing: boolean } {
  if (typeof value === "number") {
    return formatMetricNumber(value);
  }
  if (typeof value === "boolean") {
    return { value: value ? "Yes" : "No", missing: false };
  }
  if (typeof value === "string") {
    return formatMetricString(value);
  }
  if (Array.isArray(value)) {
    return { value: value.length.toLocaleString("en-US"), missing: false };
  }
  return { value: DOCK_METRIC_MISSING, missing: true };
}

function formatMetricNumber(value: number): { value: string; missing: boolean } {
  if (!Number.isFinite(value)) {
    return { value: DOCK_METRIC_MISSING, missing: true };
  }
  if (Number.isInteger(value)) {
    return { value: value.toLocaleString("en-US"), missing: false };
  }
  return { value: value.toLocaleString("en-US", { maximumFractionDigits: DOCK_METRIC_FRACTION_DIGITS }), missing: false };
}

function formatMetricString(value: string): { value: string; missing: boolean } {
  const trimmed = value.trim();
  if (trimmed === "") {
    return { value: DOCK_METRIC_MISSING, missing: true };
  }
  if (trimmed.length <= DOCK_METRIC_STRING_LIMIT) {
    return { value: trimmed, missing: false };
  }
  return { value: `${trimmed.slice(0, DOCK_METRIC_STRING_LIMIT - 1)}…`, missing: false };
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
