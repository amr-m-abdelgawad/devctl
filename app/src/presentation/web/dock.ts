import {
  DOCK_DEFAULT_REFRESH_SECONDS,
  DOCK_FETCH_TIMEOUT_MS,
  DOCK_KIND_IFRAME,
  DOCK_KIND_TEXT,
  DOCK_MAX_TEXT_CHARS,
  dockRefreshSeconds,
  dockSourceLabel,
  extractDockMetrics,
  formatDockText,
  loopbackFetchUrl,
  resolveDockTarget,
  type DockMetricReading,
} from "../../domain/config/dock.ts";
import type { DevctlConfig, WebDockItem, WebDockMetric } from "../../domain/config/types.ts";
import type { StatusSnapshot } from "../../domain/status.ts";

export type DockMetric = {
  key: string;
  label: string;
  value: string;
  unit?: string;
  missing?: boolean;
};

export type DockCard = {
  id: string;
  title: string;
  kind: "iframe" | "text";
  source: string;
  url?: string;
  text?: string;
  error?: string;
  truncated?: boolean;
  metrics?: DockMetric[];
  metrics_error?: string;
  refresh_seconds: number;
};

export type DockPayload = {
  items: DockCard[];
  refresh_seconds: number;
};

const DOCK_USER_AGENT = "devctl-dock";

export async function readDock(cfg: DevctlConfig, status: StatusSnapshot, consolePort: number): Promise<DockPayload> {
  const assigned: Record<string, Record<string, number>> = {};
  for (const [name, runtime] of Object.entries(status.services)) {
    assigned[name] = runtime.ports;
  }
  const items = await Promise.all(cfg.web.dock.map((item) => readDockItem(item, cfg, assigned, consolePort)));
  const refresh = items.reduce((min, item) => Math.min(min, item.refresh_seconds), DOCK_DEFAULT_REFRESH_SECONDS);
  return { items, refresh_seconds: refresh };
}

async function readDockItem(
  item: WebDockItem,
  cfg: DevctlConfig,
  assigned: Record<string, Record<string, number>>,
  consolePort: number,
): Promise<DockCard> {
  const target = resolveDockTarget(item, cfg, assigned, consolePort);
  const card: DockCard = {
    id: item.id,
    title: item.title.trim(),
    kind: item.kind === DOCK_KIND_IFRAME ? DOCK_KIND_IFRAME : DOCK_KIND_TEXT,
    source: target.url === "" ? "" : dockSourceLabel(target.url),
    refresh_seconds: dockRefreshSeconds(item),
  };
  if (item.kind !== DOCK_KIND_IFRAME && item.kind !== DOCK_KIND_TEXT) {
    return { ...card, error: "unsupported kind" };
  }
  if (target.error !== "" || target.url === "") {
    return { ...card, error: target.error || "no address" };
  }
  if (item.kind === DOCK_KIND_IFRAME) {
    return { ...card, url: target.url };
  }
  return { ...card, ...(await fetchDockText(target.url, item.metrics)) };
}

async function fetchDockText(raw: string, metrics: WebDockMetric[]): Promise<Pick<DockCard, "text" | "error" | "truncated" | "metrics" | "metrics_error">> {
  let url = raw;
  try {
    url = loopbackFetchUrl(raw);
  } catch {
    return { error: "must be an absolute http(s) URL" };
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(DOCK_FETCH_TIMEOUT_MS),
      headers: {
        accept: "text/plain, text/html, application/json;q=0.9, */*;q=0.1",
        "user-agent": DOCK_USER_AGENT,
      },
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      return { error: "redirects are not followed" };
    }
    const type = res.headers.get("content-type") ?? "";
    if (isBinaryType(type)) {
      await res.body?.cancel();
      return { error: "the response is not text" };
    }
    const read = await readCapped(res.body, DOCK_MAX_TEXT_CHARS);
    return dockTextFields(type, read.text, read.truncated, res.ok, res.status, metrics);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "request failed" };
  }
}

function dockTextFields(
  contentType: string,
  body: string,
  truncated: boolean,
  ok: boolean,
  status: number,
  metrics: WebDockMetric[],
): Pick<DockCard, "text" | "error" | "truncated" | "metrics" | "metrics_error"> {
  const extracted = extractDockMetrics(contentType, body, metrics);
  return {
    text: formatDockText(contentType, body),
    error: ok ? undefined : `HTTP ${status}`,
    truncated: truncated ? true : undefined,
    metrics: extracted.readings.length === 0 ? undefined : extracted.readings.map(toDockMetric),
    metrics_error: extracted.error === "" ? undefined : extracted.error,
  };
}

function toDockMetric(reading: DockMetricReading): DockMetric {
  return {
    key: reading.key,
    label: reading.label,
    value: reading.value,
    unit: reading.unit === "" ? undefined : reading.unit,
    missing: reading.missing ? true : undefined,
  };
}

function isBinaryType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/") || type.includes("octet-stream");
}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!body) {
    return { text: "", truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let finished = false;
  while (!finished && !truncated) {
    const step = await reader.read();
    finished = step.done;
    const value = step.value;
    if (value && value.byteLength > 0) {
      const room = max - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, Math.max(room, 0)));
        truncated = true;
        await reader.cancel();
      } else {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(concatBytes(chunks)), truncated };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
