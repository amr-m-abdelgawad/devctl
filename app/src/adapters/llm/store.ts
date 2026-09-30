import { Detector } from "../secrets/detector.ts";
import { BodyBudget, textBytes } from "../capture/body-store.ts";
import { captureStoreBytes } from "../../domain/logs/budgets.ts";
import { coerceAnyValue } from "../../domain/logs/any-value.ts";
import type { LlmCallStore } from "../../ports/llm-call-store.ts";
import {
  clampLlmPageSize,
  DEFAULT_LLM_STORE_CAP,
  isLlmErrorStatus,
  matchesLlmCall,
  redactLlmCall,
  summarizeLlmCall,
  type LlmCall,
  type LlmCallFacets,
  type LlmCallFilter,
  type LlmCallIngest,
  type LlmCallPage,
  type LlmCallPageRequest,
  type LlmSourceError,
} from "../../domain/llm/llm.ts";

type LlmCursor = { seq: number };

function encodeCursor(cursor: LlmCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): LlmCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { seq?: unknown }).seq === "number") {
      return parsed as LlmCursor;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const LLM_BODY_SEARCH = Symbol.for("devctl.llmBodySearch");

/** A redacted body as compact text. `json` is false when the body was a plain string. */
type StoredBody = { readonly text: string; readonly json: boolean };

/**
 * One call as held in memory: metadata without payloads, plus each body once
 * as compact text. Bodies are parsed only when a caller asks for the call.
 */
type StoredCall = {
  readonly call: LlmCall;
  request?: StoredBody;
  response?: StoredBody;
};

export class LlmCallManager implements LlmCallStore {
  private records: StoredCall[] = [];
  private byId = new Map<string, StoredCall>();
  private nextSeq = 1;
  private readonly cap: number;
  private detector?: Detector;
  private readonly errors = new Map<string, LlmSourceError>();
  private readonly bodies: BodyBudget;

  constructor(detector?: Detector, cap: number = DEFAULT_LLM_STORE_CAP, maxBytes = 0) {
    this.detector = detector;
    this.cap = cap > 0 ? cap : DEFAULT_LLM_STORE_CAP;
    this.bodies = new BodyBudget(captureStoreBytes(maxBytes));
  }

  setSecrets(extraMarkers: string[], extraPatterns: string[], redact?: boolean): void {
    if (this.detector) {
      this.detector.update(extraMarkers, extraPatterns, redact);
      return;
    }
    this.detector = new Detector(extraMarkers, extraPatterns, redact !== false);
  }

  upsert(calls: LlmCallIngest[]): void {
    for (const incoming of calls) {
      if (incoming.id.trim() !== "") {
        this.upsertOne(incoming);
      }
    }
    this.trim();
  }

  private upsertOne(incoming: LlmCallIngest): void {
    const existing = this.byId.get(incoming.id);
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const built: LlmCall = { ...incoming, seq };
    const { request, response, ...meta } = this.detector ? redactLlmCall(this.detector, built) : built;
    const record: StoredCall = { call: meta, request: encodeBody(request), response: encodeBody(response) };
    // Search reads the bodies' current text, so an evicted body stops matching
    // without anything rewriting this property.
    Object.defineProperty(meta, LLM_BODY_SEARCH, { get: () => bodySearchText(record), enumerable: false });
    this.byId.set(meta.id, record);
    if (existing) {
      this.records = this.records.filter((item) => item !== existing);
    }
    this.records.push(record);
    this.markEvicted(this.bodies.put(meta.id, textBytes(record.request?.text) + textBytes(record.response?.text)));
  }

  queryPage(filter: LlmCallFilter, page?: LlmCallPageRequest): LlmCallPage {
    // Records are kept in seq order, so walking backwards is newest first.
    const matched: StoredCall[] = [];
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record !== undefined && matchesLlmCall(filter, record.call)) {
        matched.push(record);
      }
    }
    const limit = clampLlmPageSize(page?.limit);
    const cursor = page?.cursor ? decodeCursor(page.cursor) : undefined;
    const start = cursor ? matched.findIndex((record) => record.call.seq < cursor.seq) : 0;
    const from = start < 0 ? matched.length : start;
    const slice = matched.slice(from, from + limit);
    const last = slice[slice.length - 1];
    const nextIndex = from + slice.length;
    return {
      calls: slice.map((record) => (page?.summary === true ? summarizeLlmCall(record.call) : withBodies(record))),
      nextCursor: last ? encodeCursor({ seq: last.call.seq }) : "",
      hasNext: nextIndex < matched.length,
      errors: this.sourceErrors(),
    };
  }

  get(id: string): LlmCall | undefined {
    const record = this.byId.get(id);
    return record === undefined ? undefined : withBodies(record);
  }

  facets(filter: LlmCallFilter): LlmCallFacets {
    const bySource: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    let errors = 0;
    for (const { call } of this.records) {
      if (!matchesLlmCall(filter, call)) {
        continue;
      }
      total += 1;
      bySource[call.source] = (bySource[call.source] ?? 0) + 1;
      byModel[call.model] = (byModel[call.model] ?? 0) + 1;
      byStatus[call.status] = (byStatus[call.status] ?? 0) + 1;
      if (isLlmErrorStatus(call.status)) {
        errors += 1;
      }
    }
    return { total, errors, bySource, byModel, byStatus };
  }

  setSourceError(source: string, message: string, status?: number): void {
    this.errors.set(source, { source, message, status });
  }

  clearSourceError(source: string): void {
    this.errors.delete(source);
  }

  sourceErrors(): LlmSourceError[] {
    return [...this.errors.values()];
  }

  shedBodies(): void {
    this.markEvicted(this.bodies.shedAll());
  }

  close(): void {
    this.records = [];
    this.byId.clear();
    this.errors.clear();
    this.bodies.shedAll();
  }

  private trim(): void {
    if (this.records.length <= this.cap) {
      return;
    }
    const removed = this.records.splice(0, this.records.length - this.cap);
    for (const { call } of removed) {
      this.byId.delete(call.id);
      this.bodies.drop(call.id);
    }
  }

  private markEvicted(ids: string[]): void {
    for (const id of ids) {
      const record = this.byId.get(id);
      if (record) {
        record.request = undefined;
        record.response = undefined;
        record.call.attributes = { ...record.call.attributes, body: "evicted" };
      }
    }
  }
}

function withBodies(record: StoredCall): LlmCall {
  return { ...record.call, request: decodeBody(record.request), response: decodeBody(record.response) };
}

function bodySearchText(record: StoredCall): string {
  if (record.request === undefined && record.response === undefined) {
    return "";
  }
  return `${record.request?.text ?? ""}\n${record.response?.text ?? ""}`;
}

function encodeBody(value: unknown): StoredBody | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return { text: value, json: false };
  }
  const text = compactJson(value) ?? compactJson(coerceAnyValue(value));
  return text === undefined ? undefined : { text, json: true };
}

function compactJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? undefined;
  } catch {
    return undefined;
  }
}

function decodeBody(body: StoredBody | undefined): unknown {
  if (body === undefined) {
    return undefined;
  }
  return body.json ? (JSON.parse(body.text) as unknown) : body.text;
}
