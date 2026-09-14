import { Detector } from "../secrets/detector.ts";
import type { LlmCallStore } from "../../ports/llm-call-store.ts";
import {
  clampLlmPageSize,
  DEFAULT_LLM_STORE_CAP,
  isLlmErrorStatus,
  matchesLlmCall,
  redactLlmCall,
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

export class LlmCallManager implements LlmCallStore {
  private items: LlmCall[] = [];
  private byId = new Map<string, LlmCall>();
  private nextSeq = 1;
  private readonly cap: number;
  private detector?: Detector;
  private readonly errors = new Map<string, LlmSourceError>();

  constructor(detector?: Detector, cap: number = DEFAULT_LLM_STORE_CAP) {
    this.detector = detector;
    this.cap = cap > 0 ? cap : DEFAULT_LLM_STORE_CAP;
  }

  setSecrets(extraMarkers: string[], extraPatterns: string[]): void {
    if (this.detector) {
      this.detector.update(extraMarkers, extraPatterns);
      return;
    }
    this.detector = new Detector(extraMarkers, extraPatterns);
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
    const stored = this.detector ? redactLlmCall(this.detector, built) : built;
    this.byId.set(stored.id, stored);
    if (existing) {
      this.items = this.items.filter((item) => item.id !== stored.id);
    }
    this.items.push(stored);
  }

  queryPage(filter: LlmCallFilter, page?: LlmCallPageRequest): LlmCallPage {
    const matched = this.items.filter((call) => matchesLlmCall(filter, call)).sort((a, b) => b.seq - a.seq);
    const limit = clampLlmPageSize(page?.limit);
    const cursor = page?.cursor ? decodeCursor(page.cursor) : undefined;
    const start = cursor ? matched.findIndex((call) => call.seq < cursor.seq) : 0;
    const from = start < 0 ? matched.length : start;
    const slice = matched.slice(from, from + limit);
    const last = slice[slice.length - 1];
    const nextIndex = from + slice.length;
    return {
      calls: slice,
      nextCursor: last ? encodeCursor({ seq: last.seq }) : "",
      hasNext: nextIndex < matched.length,
      errors: this.sourceErrors(),
    };
  }

  get(id: string): LlmCall | undefined {
    return this.byId.get(id);
  }

  facets(filter: LlmCallFilter): LlmCallFacets {
    const matched = this.items.filter((call) => matchesLlmCall(filter, call));
    const bySource: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let errors = 0;
    for (const call of matched) {
      bySource[call.source] = (bySource[call.source] ?? 0) + 1;
      byModel[call.model] = (byModel[call.model] ?? 0) + 1;
      byStatus[call.status] = (byStatus[call.status] ?? 0) + 1;
      if (isLlmErrorStatus(call.status)) {
        errors += 1;
      }
    }
    return { total: matched.length, errors, bySource, byModel, byStatus };
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

  close(): void {
    this.items = [];
    this.byId.clear();
    this.errors.clear();
  }

  private trim(): void {
    if (this.items.length <= this.cap) {
      return;
    }
    const drop = this.items.length - this.cap;
    const removed = this.items.splice(0, drop);
    for (const call of removed) {
      this.byId.delete(call.id);
    }
  }
}
