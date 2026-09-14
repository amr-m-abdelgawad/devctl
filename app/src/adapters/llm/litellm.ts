import { LLM_SOURCE_TYPE_LITELLM, type LlmSourceConfig } from "../../domain/config/types.ts";
import { normalizeLlmPathPrefix, type LlmCallIngest, type LlmSourceCapabilities } from "../../domain/llm/llm.ts";
import type { LlmSourceContext, LlmSourceDriver } from "../../ports/llm-source.ts";
import { mapLiteLlmSpendLogs } from "./litellm-map.ts";

export const LLM_SPEND_LOGS_PATH = "spend/logs";
const HTTP_OK_MAX = 300;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const FETCH_TIMEOUT_MS = 15_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class LlmSourceHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type LlmHttpGet = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;

export function litellmDriver(httpGet: LlmHttpGet = defaultLlmHttpGet): LlmSourceDriver {
  return {
    name: LLM_SOURCE_TYPE_LITELLM,
    capabilities: (cfg) => capabilitiesFor(cfg),
    fetch: (cfg, ctx) => fetchSpendLogs(cfg, ctx, httpGet),
  };
}

function capabilitiesFor(cfg: LlmSourceConfig): LlmSourceCapabilities {
  return {
    hasBodies: cfg.capture.prompts,
    hasCost: true,
    hasUsage: true,
    liveQuery: true,
  };
}

async function fetchSpendLogs(cfg: LlmSourceConfig, ctx: LlmSourceContext, httpGet: LlmHttpGet): Promise<LlmCallIngest[]> {
  const url = spendLogsUrl(ctx.baseUrl, ctx.pathPrefix, ctx.since);
  const result = await httpGet(url, ctx.headers);
  if (result.status === HTTP_NOT_FOUND || result.status === HTTP_UNAUTHORIZED || result.status === HTTP_FORBIDDEN) {
    throw new LlmSourceHttpError(
      result.status,
      "this URL is not LiteLLM management; set path_prefix or management_endpoint",
    );
  }
  if (result.status < 200 || result.status >= HTTP_OK_MAX) {
    throw new LlmSourceHttpError(result.status, `LiteLLM spend logs returned HTTP ${result.status}`);
  }
  return mapLiteLlmSpendLogs(cfg.name, result.body, cfg.capture.prompts);
}

export function spendLogsUrl(baseUrl: string, pathPrefix: string, since?: string): string {
  const joined = joinLlmUrl(baseUrl, pathPrefix, LLM_SPEND_LOGS_PATH);
  const url = new URL(joined);
  url.searchParams.set("summarize", "false");
  const range = dateRange(since);
  url.searchParams.set("start_date", range.start);
  url.searchParams.set("end_date", range.end);
  return url.toString();
}

export function joinLlmUrl(baseUrl: string, pathPrefix: string, leaf: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  const mid = normalizeLlmPathPrefix(pathPrefix);
  const path = leaf.replace(/^\/+/, "");
  if (mid === "") {
    return `${root}/${path}`;
  }
  return `${root}/${mid}/${path}`;
}

function dateRange(since?: string): { start: string; end: string } {
  const end = new Date();
  const start = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : new Date(end.getTime() - MS_PER_DAY);
  return { start: ymd(start), end: ymd(new Date(end.getTime() + MS_PER_DAY)) };
}

function ymd(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function defaultLlmHttpGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await resp.text();
    let body: unknown = text;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}
