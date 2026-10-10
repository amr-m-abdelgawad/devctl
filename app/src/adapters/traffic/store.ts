import { Detector } from "../secrets/detector.ts";
import { BodyBudget, textBytes } from "../capture/body-store.ts";
import { captureStoreBytes } from "../../domain/logs/budgets.ts";
import type { TrafficCallStore } from "../../ports/traffic-call-store.ts";
import {
  clampTrafficPageSize,
  DEFAULT_TRAFFIC_STORE_CAP,
  matchesTrafficCall,
  redactTrafficCall,
  summarizeTrafficCall,
  type TrafficCall,
  type TrafficCallFilter,
  type TrafficCallIngest,
  type TrafficCallPage,
  type TrafficCallPageRequest,
  type TrafficPayload,
} from "../../domain/traffic/traffic.ts";

type TrafficCursor = { seq: number };

function encodeTrafficCursor(cursor: TrafficCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTrafficCursor(raw: string): TrafficCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { seq?: unknown }).seq === "number") {
      return parsed as TrafficCursor;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class TrafficCallRing implements TrafficCallStore {
  private items: TrafficCall[] = [];
  private byId = new Map<string, TrafficCall>();
  private nextSeq = 1;
  private readonly cap: number;
  private detector?: Detector;
  private readonly bodies: BodyBudget;

  constructor(detector?: Detector, cap: number = DEFAULT_TRAFFIC_STORE_CAP, maxBytes = 0) {
    this.detector = detector;
    this.cap = cap > 0 ? cap : DEFAULT_TRAFFIC_STORE_CAP;
    this.bodies = new BodyBudget(captureStoreBytes(maxBytes));
  }

  setSecrets(extraMarkers: string[], extraPatterns: string[], redact?: boolean): void {
    if (this.detector) {
      this.detector.update(extraMarkers, extraPatterns, redact);
      return;
    }
    this.detector = new Detector(extraMarkers, extraPatterns, redact !== false);
  }

  upsert(calls: TrafficCallIngest[]): void {
    for (const incoming of calls) {
      if (incoming.id.trim() !== "") {
        this.upsertOne(incoming);
      }
    }
    this.trim();
  }

  private upsertOne(incoming: TrafficCallIngest): void {
    const existing = this.byId.get(incoming.id);
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const built: TrafficCall = { ...incoming, seq };
    const stored = this.detector ? redactTrafficCall(this.detector, built) : built;
    this.byId.set(stored.id, stored);
    if (existing) {
      this.items = this.items.filter((item) => item.id !== stored.id);
    }
    this.items.push(stored);
    this.dropBodies(this.bodies.put(stored.id, payloadBytes(stored.request) + payloadBytes(stored.response)));
  }

  queryPage(filter: TrafficCallFilter, page?: TrafficCallPageRequest): TrafficCallPage {
    const matched = this.items.filter((call) => matchesTrafficCall(filter, call)).sort((a, b) => b.seq - a.seq);
    const limit = clampTrafficPageSize(page?.limit);
    const cursor = page?.cursor ? decodeTrafficCursor(page.cursor) : undefined;
    const start = cursor ? matched.findIndex((call) => call.seq < cursor.seq) : 0;
    const from = start < 0 ? matched.length : start;
    const slice = matched.slice(from, from + limit);
    const last = slice[slice.length - 1];
    const nextIndex = from + slice.length;
    return {
      calls: page?.summary === true ? slice.map((call) => summarizeTrafficCall(call)) : slice,
      nextCursor: last ? encodeTrafficCursor({ seq: last.seq }) : "",
      hasNext: nextIndex < matched.length,
    };
  }

  get(id: string): TrafficCall | undefined {
    return this.byId.get(id);
  }

  shedBodies(): void {
    this.dropBodies(this.bodies.shedAll());
  }

  close(): void {
    this.items = [];
    this.byId.clear();
    this.bodies.shedAll();
  }

  private trim(): void {
    if (this.items.length <= this.cap) {
      return;
    }
    const drop = this.items.length - this.cap;
    const removed = this.items.splice(0, drop);
    for (const call of removed) {
      this.byId.delete(call.id);
      this.bodies.drop(call.id);
    }
  }

  // Both the decoded text and the raw base64 go, so an evicted gRPC or binary
  // body frees everything it held.
  private dropBodies(ids: string[]): void {
    for (const id of ids) {
      const call = this.byId.get(id);
      if (call) {
        const summary = summarizeTrafficCall(call);
        call.request = summary.request;
        call.response = summary.response;
      }
    }
  }
}

/** A payload's text and base64 are both held, so both count. */
function payloadBytes(payload: TrafficPayload | undefined): number {
  return textBytes(payload?.text) + textBytes(payload?.data);
}
