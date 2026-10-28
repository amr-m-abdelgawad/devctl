// Frozen from main@ed58322 app/src/adapters/storage/logs.ts: the LogManager
// append path, for the ingest oracle. Do not edit.
//
// Kept verbatim: append, commitFolded, commitIngest, the proxy-hop request-id
// correlation, access-line dedupe, the multiline idle flush, and the ring.
// Removed because they do not decide record content: the bus, persistence
// streams, query/facets/export, ring counters, and secret redaction (the
// oracle runs without a Detector, and so does the side it is compared with).
import type { ServiceLogConfig } from "./domain/config-types.ts";
import { buildLogRecord } from "./domain/logs/record.ts";
import { requestIdAttribute } from "./domain/logs/dedupe.ts";
import { PROXY_HOP_CORRELATE_WINDOW_MS, shouldTagServiceLogWithProxyHop, withRequestId } from "./domain/logs/correlate.ts";
import { isProcessLogSource, MultilineAssembler, type FoldedLog } from "./domain/logs/multiline.ts";
import { parseLogLine, truncateLogLine } from "./domain/logs/parse.ts";
import { shouldDropAccessLine } from "./domain/logs/access-line.ts";
import { SeverityUnspecified } from "./domain/logs/severity.ts";
import type { LogIngest, LogParser, LogRecord, ParsedLog } from "./domain/logs/types.ts";

const DEFAULT_MAX_EVENTS = 50_000;

type CorrelateCandidate = {
  readonly event: LogRecord;
  readonly arrivedMs: number;
};

function accessLineKey(service: string, pid: number): string {
  return `${service}\0${pid}`;
}

export class PreBranchLogManager {
  private events: LogRecord[] = [];
  private eventStart = 0;
  private nextSeq = 1;
  private readonly max: number;
  private parsers: LogParser[] = [];
  private readonly assembler = new MultilineAssembler();
  private serviceLogs = new Map<string, ServiceLogConfig>();
  private lastByServicePid = new Map<string, LogRecord>();
  private recentCorrelate: CorrelateCandidate[] = [];
  private idleTimer?: ReturnType<typeof setTimeout>;
  private onRecord?: (event: LogRecord) => void;

  constructor(max: number) {
    this.max = max > 0 ? max : DEFAULT_MAX_EVENTS;
  }

  setParsers(parsers: LogParser[]): void {
    this.parsers = parsers;
  }

  setServiceLogs(logs: Record<string, ServiceLogConfig>): void {
    this.serviceLogs = new Map(Object.entries(logs));
  }

  setOnRecord(handler: ((event: LogRecord) => void) | undefined): void {
    this.onRecord = handler;
  }

  append(ev: LogIngest): LogRecord | undefined {
    if (!shouldFoldProcessLine(ev)) {
      this.flushPending();
      return this.commitIngest(ev);
    }
    let last: LogRecord | undefined;
    for (const folded of this.assembler.push(ev, Date.now(), this.serviceLogs.get(ev.service)?.multiline)) {
      last = this.commitFolded(folded);
    }
    this.scheduleIdleFlush();
    return last;
  }

  flush(): void {
    this.flushPending();
  }

  /** The ring, oldest first, the way main's query() visited it. */
  records(): LogRecord[] {
    this.flushPending();
    const out: LogRecord[] = [];
    const count = this.events.length;
    for (let offset = 0; offset < count; offset += 1) {
      const event = this.events[(this.eventStart + offset) % count];
      if (event) {
        out.push(event);
      }
    }
    return out;
  }

  private parseLine(line: string): ParsedLog {
    let out: ParsedLog = parseLogLine(line);
    for (const parser of this.parsers) {
      try {
        const result = parser.parse(line);
        if (result) {
          out = { ...out, ...result };
        }
      } catch {
        // a misbehaving plugin parser must not break log ingestion
      }
    }
    return out;
  }

  private commitFolded(folded: FoldedLog): LogRecord | undefined {
    const ev: LogIngest = { ...folded.ingest };
    if (folded.severityNumber !== SeverityUnspecified && ev.severityNumber === undefined) {
      ev.severityNumber = folded.severityNumber;
    }
    return this.commitIngest(ev, folded.arrivedMs);
  }

  private commitIngest(ev: LogIngest, arrivedMs = Date.now()): LogRecord | undefined {
    const skipParse = ev.body !== undefined || ev.source === "otlp";
    const line = truncateLogLine(ev.message ?? (typeof ev.body === "string" ? ev.body : ""));
    const parsed = skipParse ? ingestAsParsed(ev) : this.parseLine(line);
    const built = buildLogRecord(ev, parsed, this.nextSeq);
    const redacted = built;
    this.expireCorrelate(Date.now());
    const next = this.attachProxyRequestId(redacted, arrivedMs);
    if (this.shouldDropAccessDuplicate(ev, next)) {
      return undefined;
    }
    if (this.serviceLogs.get(ev.service)?.dedupe_access_line === true) {
      this.rememberAccessLine(ev.service, ev.pid, next);
    }
    this.nextSeq += 1;
    this.pushRing(next);
    this.tagRecentServiceLogs(next, arrivedMs);
    this.rememberCorrelate(next, arrivedMs);
    this.publishRecord(next);
    return next;
  }

  private attachProxyRequestId(event: LogRecord, arrivedMs: number): LogRecord {
    if (requestIdAttribute(event) !== "") {
      return event;
    }
    for (const prev of this.recentCorrelate) {
      if (this.inCorrelateArrivalWindow(prev.arrivedMs, arrivedMs) && shouldTagServiceLogWithProxyHop(prev.event, event)) {
        return withRequestId(event, requestIdAttribute(prev.event));
      }
    }
    return event;
  }

  private tagRecentServiceLogs(event: LogRecord, arrivedMs: number): void {
    const requestId = requestIdAttribute(event);
    if (requestId === "") {
      return;
    }
    for (const prev of this.recentCorrelate) {
      if (this.inCorrelateArrivalWindow(prev.arrivedMs, arrivedMs) && shouldTagServiceLogWithProxyHop(event, prev.event)) {
        this.replaceRecord(prev.event.seq, withRequestId(prev.event, requestId));
      }
    }
  }

  private inCorrelateArrivalWindow(prevArrivedMs: number, arrivedMs: number): boolean {
    return Math.abs(prevArrivedMs - arrivedMs) <= PROXY_HOP_CORRELATE_WINDOW_MS;
  }

  private replaceRecord(seq: number, updated: LogRecord): void {
    const count = this.events.length;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.eventStart + offset) % count;
      if (this.events[index]?.seq === seq) {
        this.events[index] = updated;
        break;
      }
    }
    this.recentCorrelate = this.recentCorrelate.map((row) =>
      row.event.seq === seq ? { event: updated, arrivedMs: row.arrivedMs } : row,
    );
    this.publishRecord(updated);
  }

  private expireCorrelate(nowMs: number): void {
    const cutoff = nowMs - PROXY_HOP_CORRELATE_WINDOW_MS;
    this.recentCorrelate = this.recentCorrelate.filter((row) => row.arrivedMs >= cutoff);
  }

  private rememberCorrelate(event: LogRecord, arrivedMs = Date.now()): void {
    this.recentCorrelate.push({ event, arrivedMs });
  }

  private pushRing(event: LogRecord): void {
    if (this.events.length < this.max) {
      this.events.push(event);
      return;
    }
    this.events[this.eventStart] = event;
    this.eventStart = (this.eventStart + 1) % this.max;
  }

  private publishRecord(event: LogRecord): void {
    this.onRecord?.(event);
  }

  private shouldDropAccessDuplicate(ev: LogIngest, next: LogRecord): boolean {
    if (this.serviceLogs.get(ev.service)?.dedupe_access_line !== true) {
      return false;
    }
    if (!(ev.pid > 0)) {
      return false;
    }
    const prev = this.lastByServicePid.get(accessLineKey(ev.service, ev.pid));
    return prev !== undefined && shouldDropAccessLine(prev, next);
  }

  private rememberAccessLine(service: string, pid: number, event: LogRecord): void {
    if (pid > 0) {
      this.lastByServicePid.set(accessLineKey(service, pid), event);
    }
  }

  private flushPending(): void {
    for (const folded of this.assembler.flushAll()) {
      this.commitFolded(folded);
    }
    this.clearIdleTimer();
  }

  private scheduleIdleFlush(): void {
    this.clearIdleTimer();
    const deadline = this.assembler.nextDeadlineMs();
    if (deadline === undefined) {
      return;
    }
    const delay = Math.max(0, deadline - Date.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      for (const folded of this.assembler.flushDue(Date.now())) {
        this.commitFolded(folded);
      }
      this.scheduleIdleFlush();
    }, delay);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}

function shouldFoldProcessLine(ev: LogIngest): boolean {
  return isProcessLogSource(ev.source) && ev.body === undefined;
}

function ingestAsParsed(ev: LogIngest): ParsedLog {
  return {
    body: ev.body,
    attributes: ev.attributes,
    severityNumber: ev.severityNumber,
    severityText: ev.severityText ?? ev.level,
    traceId: ev.traceId,
    spanId: ev.spanId,
    traceFlags: ev.traceFlags,
    timeUnixNano: ev.timeUnixNano,
    observedTimeUnixNano: ev.observedTimeUnixNano,
    scope: ev.scope,
    resource: ev.resource,
    raw: ev.raw,
    message: ev.message,
    request_id: ev.request_id,
  };
}
