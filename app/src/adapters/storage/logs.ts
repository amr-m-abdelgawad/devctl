import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Bus, LogBatch, LogReceived, newEvent } from "../../shared/events.ts";
import { type Detector } from "../secrets/detector.ts";
import type { LogSnapshot, LogStore } from "../../ports/log-store.ts";
import { logsDir } from "./storage.ts";
import { LogRing } from "./log-ring.ts";
import { indexedSource, pageSource, stackedSource, type SeqSource } from "./log-page.ts";
import { SessionLogWriter } from "./log-persist.ts";
import { HISTORY_SCAN_BYTES, HISTORY_SCAN_MS, LOG_PAGE_MAX_BYTES, PROCESS_SLICE_MS } from "../../domain/logs/budgets.ts";
import { LogBatcher } from "../../domain/logs/batch.ts";
import { ProxyHopWindow } from "../../domain/logs/hop-window.ts";
import { IngestPipeline, sessionSpoolPrefix, type PipelineChunk, type PipelineLimits, type PipelineLine, type PipelineStreamKey } from "./ingest/pipeline.ts";
import { leftoverSpoolDirs, replayLeftoverSpools, sessionHistorySink, type ReplayLine } from "./spool-replay.ts";
import { readSelfStamp } from "../process/liveness.ts";
import { writeLogExport } from "./log-export.ts";
import { safeServiceFile, SESSION_FORMAT_FILE, SESSION_FORMAT_JSONL, SESSION_PREFIX } from "./session-files.ts";
import { matchCacheKey, SessionHistory } from "./session-history.ts";
import { readBudget, SessionReader } from "./session-reader.ts";
import { pruneSessions, type SessionOwner } from "./session-prune.ts";

import type { ServiceLogConfig } from "../../domain/config/types.ts";
import {
  buildLogRecord,
  clampLogPageSize,
  createLogMatcher,
  createSearchMatcher,
  decodeLogCursor,
  dedupeLogsByRequestId,
  encodeLogCursor,
  isErrorSeverity,
  isProcessLogSource,
  matchesLogDimensions,
  MultilineAssembler,
  parseLogLine,
  redactLogRecord,
  shouldDropAccessLine,
  SeverityUnspecified,
  truncateLogLine,
  type FoldedLog,
  type LogFacets,
  type LogFilter,
  type LogIngest,
  type LogMatcher,
  type LogPage,
  type LogPageDirection,
  type LogPageRequest,
  type LogParser,
  type LogRecord,
  type ParsedLog,
} from "../../domain/logs/logs.ts";
export * from "../../domain/logs/logs.ts";

const DEFAULT_MAX_EVENTS = 50_000;
const PRUNE_INTERVAL_MS = 5 * 60_000;
const PRUNE_ON_ROTATE_MIN_MS = 30_000;
// Output read but not yet ingested: coalescing, transit, and the drain timer.
const IN_FLIGHT_SLACK_MS = 100;
// How often a fold that is due but waiting on its stream's queued output is re-checked.
const FOLD_BUSY_RECHECK_MS = 25;

function accessLineKey(service: string, pid: number): string {
  return `${service}\0${pid}`;
}

function foldStreamKey(key: PipelineStreamKey): string {
  return `${key.service}\0${key.stream}\0${key.pid}`;
}

function withoutFilterDimension(filter: LogFilter, dimension: "services" | "level" | "source"): LogFilter {
  const copy = { ...filter };
  copy[dimension] = undefined;
  return copy;
}

export type LogManagerOptions = {
  /** 0 keeps the historical count-only ring. */
  maxMemoryBytes?: number;
  pendingLimitBytes?: number;
  /** When set, `max_session_logs` counts only this repository's sessions. */
  repoKey?: string;
  /** 0 uses the 1 GiB session default inside the writer. */
  maxSessionBytes?: number;
  maxSpoolBytes?: number;
  /** 0 skips the cross-session byte prune. The daemon passes the 2 GiB default. */
  maxTotalBytes?: number;
  spoolDir?: string;
  /** Bytes one query may read from the session files. Defaults to HISTORY_SCAN_BYTES. */
  historyScanBytes?: number;
  /** Time one query may spend reading the session files. Defaults to HISTORY_SCAN_MS. */
  historyScanMs?: number;
  /** Pipeline thresholds; `maxSpoolBytes` still sets the spool budget. */
  pipelineLimits?: PipelineLimits;
  /** The lowest seq to assign, for a store taking over a session whose records were already published. */
  firstSeq?: number;
};

export class LogManager {
  private nextSeq = 1;
  private recorded = 0;
  private errorCount = 0;
  private readonly ring: LogRing;
  private readonly max: number;
  private readonly bus?: Bus;
  private readonly detector?: Detector;
  private readonly persistDir: string;
  private readonly persist: boolean;
  private readonly sessionID: string;
  private writer?: SessionLogWriter;
  // Reads the part of the window the ring has evicted back from this session's files.
  private evicted?: SessionReader;
  private readonly scanBytes: number;
  private readonly scanMs: number;
  private readonly history: SessionHistory;
  private parsers: LogParser[] = [];
  private readonly assembler = new MultilineAssembler();
  private serviceLogs = new Map<string, ServiceLogConfig>();
  private lastByServicePid = new Map<string, LogRecord>();
  private readonly hopWindow = new ProxyHopWindow();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleTimerAt = 0;
  /** Streams a leftover spool is replaying; their folds close by event time only. */
  private readonly replaying = new Set<string>();
  private readonly pipelineLimits: PipelineLimits;
  private onRecord?: (event: LogRecord) => void;
  private pipeline?: IngestPipeline;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private batcher?: LogBatcher;
  private upstreamPaused = false;
  private readonly logRoot: string;
  private readonly repoKey: string;
  private readonly retentionDays: number;
  private readonly spoolDir: string;
  private readonly maxSpoolBytes: number;
  private readonly maxSessionLogs: number;
  private readonly maxTotalBytes: number;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private lastPruneAt = 0;
  private owner?: SessionOwner;
  private closing = false;
  private readonly replay: Promise<void>;

  constructor(
    max: number,
    bus: Bus | undefined,
    detector: Detector | undefined,
    persist: boolean,
    directory: string,
    sessionID: string,
    retentionDays = 0,
    maxSessionLogs = 0,
    options: LogManagerOptions = {},
  ) {
    this.max = max > 0 ? max : DEFAULT_MAX_EVENTS;
    this.ring = new LogRing(this.max, options.maxMemoryBytes ?? 0);
    this.bus = bus;
    this.detector = detector;
    this.sessionID = sessionID;
    this.repoKey = options.repoKey ?? "";
    this.retentionDays = retentionDays;
    this.maxSpoolBytes = options.maxSpoolBytes ?? 0;
    this.pipelineLimits = options.pipelineLimits ?? {};
    const root = directory === "" || directory.startsWith("~/") ? logsDir() : directory;
    this.logRoot = root;
    this.persist = persist && sessionID !== "";
    this.persistDir = this.persist ? join(root, `${SESSION_PREFIX}${sessionID}`) : "";
    this.spoolDir = options.spoolDir ?? "";
    this.scanBytes = options.historyScanBytes ?? HISTORY_SCAN_BYTES;
    this.scanMs = options.historyScanMs ?? HISTORY_SCAN_MS;
    this.history = new SessionHistory(root, this.scanBytes, this.scanMs);
    this.maxSessionLogs = maxSessionLogs;
    this.maxTotalBytes = options.maxTotalBytes ?? 0;
    // Taken before this daemon's pipeline creates spool directories of its own.
    // A store that takes over this session (worker failover) continues the
    // session's own spool directories through its pipeline instead.
    const own = sessionSpoolPrefix(sessionID);
    const leftovers = leftoverSpoolDirs(this.spoolDir).filter((dir) => !basename(dir).startsWith(own));
    this.nextSeq = Math.max(this.nextSeq, options.firstSeq ?? 1);
    if (this.persist) {
      mkdirSync(this.persistDir, { recursive: true, mode: 0o700 });
      const inherited = readdirSync(this.persistDir);
      if (inherited.length > 0) {
        // Taking over this session: continue past every seq already written.
        this.nextSeq = Math.max(this.nextSeq, new SessionReader(this.persistDir).lastSeq(readBudget(this.scanBytes, this.scanMs)) + 1);
      }
      // Files already here belong to an earlier store of this session (a
      // worker that failed over), whose seqs restarted from 1; they are not
      // part of this store's window.
      this.evicted = new SessionReader(this.persistDir, new Set(inherited));
      writeFileSync(join(this.persistDir, SESSION_FORMAT_FILE), `${SESSION_FORMAT_JSONL}\n`, { mode: 0o600 });
      this.writer = new SessionLogWriter(this.persistDir, options.pendingLimitBytes, {
        maxSessionBytes: options.maxSessionBytes,
        onRotate: () => this.prune(PRUNE_ON_ROTATE_MIN_MS),
      });
      this.writeManifest(false);
      this.prune(0);
      this.pruneTimer = setInterval(() => this.prune(0), PRUNE_INTERVAL_MS);
      this.pruneTimer.unref?.();
    }
    this.replay = leftovers.length === 0 ? Promise.resolve() : this.replayLeftovers(leftovers);
    this.adoptSpooled();
  }

  // A store taking over this session (a replacement worker, the in-process
  // store) reads what the one before it spooled before any output of its own.
  private adoptSpooled(): void {
    const root = this.pipelineRoot();
    const prefix = sessionSpoolPrefix(this.sessionID);
    if (!leftoverSpoolDirs(root).some((dir) => basename(dir).startsWith(prefix))) {
      return;
    }
    if (this.ensurePipeline().adoptSession(this.sessionID) > 0) {
      this.scheduleDrain();
    }
  }

  /** Settles once leftover spools from an earlier daemon are replayed, or replay stopped at close. */
  replayDone(): Promise<void> {
    return this.replay;
  }

  // Output a crashed daemon had read but not parsed goes into that daemon's own
  // session history (or, without persistence, into this one's live window).
  private async replayLeftovers(dirs: string[]): Promise<void> {
    // Let the owner install parsers and service settings first.
    await new Promise((resolve) => setImmediate(resolve));
    const sink = this.persist
      ? sessionHistorySink(
          (session) => join(this.logRoot, `${SESSION_PREFIX}${session}`),
          (service) => `${safeServiceFile(service)}.jsonl`,
          (line, seq) => this.replayRecord(line, seq),
        )
      : (_header: unknown, lines: ReplayLine[]): void => {
          for (const line of lines) {
            // Its next segment is still to come: only event time may close its fold.
            this.replaying.add(foldStreamKey(line));
            this.appendLine(line);
          }
        };
    try {
      await replayLeftoverSpools(dirs, sink, () => this.closing);
    } catch {
      // Whatever was not replayed stays on disk for the next daemon.
    } finally {
      this.replaying.clear();
      this.scheduleIdleFlush();
    }
  }

  private replayRecord(line: ReplayLine, seq: number): LogRecord {
    const built = buildLogRecord(outputLineIngest(line), this.parseLine(truncateLogLine(line.line)), seq);
    return this.detector ? redactLogRecord(this.detector, built) : built;
  }

  // Keeps closed sessions within retention and the shared byte cap. Runs at
  // start, every few minutes, and (throttled) whenever a service file rolls.
  private prune(minIntervalMs: number): void {
    const now = Date.now();
    if (!this.persist || this.closing || now - this.lastPruneAt < minIntervalMs) {
      return;
    }
    this.lastPruneAt = now;
    try {
      pruneSessions(this.logRoot, this.retentionDays, this.maxSessionLogs, this.repoKey === "" ? undefined : this.repoKey, {
        maxTotalBytes: this.maxTotalBytes,
        liveDir: this.persistDir,
      });
    } catch {
      // a session another process removed mid-scan; the next round retries
    }
  }

  sessionDir(): string {
    return this.persistDir;
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

  /**
   * Raw service output in read order. False means the pipeline is full and
   * the caller must offer the same chunk again. `end` (with no bytes) marks
   * the stream finished so its last unterminated line is emitted.
   */
  acceptChunk(chunk: Omit<PipelineChunk, "session" | "bytes"> & { bytes: Uint8Array; end?: boolean }, force = false): boolean {
    const pipeline = this.ensurePipeline();
    if (chunk.bytes.byteLength > 0) {
      const accepted = pipeline.enqueueChunk({
        session: this.sessionID,
        service: chunk.service,
        stream: chunk.stream,
        pid: chunk.pid,
        readAtMs: chunk.readAtMs,
        bytes: Buffer.from(chunk.bytes),
      }, force);
      if (!accepted) {
        this.scheduleDrain();
        return false;
      }
    }
    if (chunk.end === true) {
      pipeline.endStream(chunk);
    }
    this.scheduleDrain();
    return true;
  }

  /** Output is being held back before it reaches this store (the worker's sender is out of credit). */
  setUpstreamPaused(paused: boolean): void {
    this.upstreamPaused = paused;
    if (!paused) {
      this.scheduleIdleFlush();
    }
  }

  /**
   * True when readers must stop: the pipeline refused bytes because both its
   * memory window and its spool are full. Persistence never pauses ingest;
   * a lagging writer only slows parsing while the spool absorbs the output.
   */
  ingestPaused(): boolean {
    return this.pipeline?.paused === true;
  }

  pipelineStats(): LogSnapshot["pipeline"] {
    if (this.pipeline === undefined && this.writer === undefined) {
      return undefined;
    }
    return {
      inFlightBytes: this.pipeline?.inFlightBytes() ?? 0,
      spooledBytes: (this.pipeline?.spooledBytes() ?? 0) + (this.writer?.pendingBytes() ?? 0),
      paused: this.ingestPaused(),
      loss: (this.pipeline?.loss ?? 0) + (this.writer?.loss ?? 0),
      ringBytes: this.ring.byteSize(),
      degraded: this.writer?.degraded ?? (this.pipeline?.diskFull === true ? "disk-low" : undefined),
    };
  }

  /**
   * `atMs` is the event time: when the line was read or the record logged.
   * Folding, proxy-hop pairing, and access-line dedupe go by it rather than by
   * when the record gets here, so output that was spooled, replayed, or held
   * back by a full pipeline comes out the way it would have live. Another
   * source's record does not close a pending fold.
   */
  append(ev: LogIngest, atMs = Date.now()): LogRecord | undefined {
    const now = Date.now();
    this.flushIdleFolds(now);
    if (!shouldFoldProcessLine(ev)) {
      return this.commitIngest(ev, atMs);
    }
    let last: LogRecord | undefined;
    for (const folded of this.assembler.push(ev, atMs, this.serviceLogs.get(ev.service)?.multiline, now)) {
      last = this.commitFolded(folded);
    }
    this.scheduleIdleFlush();
    return last;
  }

  async flush(): Promise<void> {
    this.drainPipeline();
    this.commitAllFolds();
    this.batcher?.flush();
    await this.writer?.flush();
  }

  setMemoryBudget(maxBytes: number): void {
    this.ring.setMaxBytes(maxBytes);
  }

  persistenceLoss(): number {
    return this.writer?.loss ?? 0;
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

  async close(): Promise<void> {
    this.closing = true;
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    await this.replay;
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    // Bytes next in line are parsed now; newer ones stay spooled for the next daemon to replay.
    await this.pipeline?.drainForClose(this.appendLine);
    await this.flush();
    this.writeManifest(true);
    await this.writer?.close();
  }

  query(filter: LogFilter): LogRecord[] {
    this.flushPending();
    const matches = createLogMatcher(filter);
    const out: LogRecord[] = [];
    this.forEachEvent((event) => {
      if (matches(event)) {
        out.push(event);
      }
    });
    return out;
  }

  /**
   * One page of the window next to a cursor. The ring is searched by seq and
   * walked only until the page is full; records older than the ring are read
   * from the session files only when the page reaches below it, so a forward
   * poll at the head never touches disk.
   */
  queryPage(filter: LogFilter, page: LogPageRequest = {}): LogPage {
    this.flushPending();
    const limit = clampLogPageSize(page.limit);
    const requested = page.cursor ? decodeLogCursor(page.cursor) : undefined;
    const sessionChanged = requested !== undefined && requested.session !== this.sessionID;
    const cursor = sessionChanged ? undefined : requested;
    const direction: LogPageDirection = cursor ? (page.direction ?? "backward") : "backward";
    const matches = createLogMatcher(filter);
    const ring = indexedSource(this.ring, matches);
    const window = this.windowSource(ring, filter, matches);
    const boundary = this.ring.oldestSeq() ?? this.nextSeq;
    // A forward page that starts in the ring looks no further back than the ring.
    const result = pageSource(window, { cursor: cursor?.seq, direction, limit, maxBytes: LOG_PAGE_MAX_BYTES }, (first) => (first >= boundary ? ring : window));
    const firstSeq = result.events[0]?.seq;
    const lastSeq = result.events[result.events.length - 1]?.seq;
    return {
      events: result.events,
      prevCursor: encodeLogCursor({ session: this.sessionID, seq: firstSeq ?? result.prevFrontier ?? cursor?.seq ?? 0 }),
      nextCursor: encodeLogCursor({ session: this.sessionID, seq: lastSeq ?? result.nextFrontier ?? cursor?.seq ?? this.nextSeq - 1 }),
      hasNext: result.hasNext,
      hasPrev: result.hasPrev,
      sessionChanged,
    };
  }

  /** One page of a persisted session's history, read like the evicted part of the window. */
  historyPage(session: string, filter: LogFilter, page: LogPageRequest = {}): LogPage {
    return this.history.page(session, filter, page);
  }

  queryFacets(filter: LogFilter): LogFacets {
    this.flushPending();
    const withoutServices = withoutFilterDimension(filter, "services");
    const withoutLevel = withoutFilterDimension(filter, "level");
    const withoutSource = withoutFilterDimension(filter, "source");
    const search = createSearchMatcher(filter);
    let total = 0;
    const byService: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    this.forEachEvent((ev) => {
      if (!search(ev)) {
        return;
      }
      if (matchesLogDimensions(filter, ev)) {
        total += 1;
      }
      if (matchesLogDimensions(withoutServices, ev)) {
        byService[ev.service] = (byService[ev.service] ?? 0) + 1;
      }
      if (matchesLogDimensions(withoutLevel, ev)) {
        byLevel[ev.severityText] = (byLevel[ev.severityText] ?? 0) + 1;
      }
      if (matchesLogDimensions(withoutSource, ev)) {
        bySource[ev.source] = (bySource[ev.source] ?? 0) + 1;
      }
    });
    return { total, byService, byLevel, bySource };
  }

  snapshot(): LogSnapshot {
    const base: LogSnapshot = {
      total: this.ring.length,
      errors: this.ring.errors,
      counts: { ...this.ring.counts },
      seen: this.recorded,
      seenErrors: this.errorCount,
    };
    const pipeline = this.pipelineStats();
    return pipeline === undefined ? base : { ...base, pipeline };
  }

  private forEachEvent(visit: (event: LogRecord) => void): void {
    this.ring.forEach(visit);
  }

  exportTo(path: string, filter: LogFilter): void {
    const events = this.query(filter);
    writeLogExport(path, filter.dedupeRequestId === true ? dedupeLogsByRequestId(events) : events);
  }

  private commitFolded(folded: FoldedLog): LogRecord | undefined {
    const ev: LogIngest = { ...folded.ingest };
    if (folded.severityNumber !== SeverityUnspecified && ev.severityNumber === undefined) {
      ev.severityNumber = folded.severityNumber;
    }
    return this.commitIngest(ev, folded.arrivedMs);
  }

  // `atMs` is the event time: the read time of a fold's first line, or when a record was logged.
  private commitIngest(ev: LogIngest, atMs: number): LogRecord | undefined {
    const skipParse = ev.body !== undefined || ev.source === "otlp";
    const line = truncateLogLine(ev.message ?? (typeof ev.body === "string" ? ev.body : ""));
    const parsed = skipParse ? ingestAsParsed(ev) : this.parseLine(line);
    const built = buildLogRecord(ev, parsed, this.nextSeq);
    const redacted = this.detector ? redactLogRecord(this.detector, built) : built;
    this.expireCorrelate(atMs);
    const next = this.hopWindow.attach(redacted, atMs);
    if (this.shouldDropAccessDuplicate(ev, next)) {
      return undefined;
    }
    if (this.serviceLogs.get(ev.service)?.dedupe_access_line === true) {
      this.rememberAccessLine(ev.service, ev.pid, next);
    }
    this.nextSeq += 1;
    this.recorded += 1;
    if (isErrorSeverity(next.severityNumber)) {
      this.errorCount += 1;
    }
    this.pushRing(next);
    for (const tagged of this.hopWindow.tagEarlier(next, atMs)) {
      this.replaceRecord(tagged);
    }
    this.hopWindow.remember(next, atMs);
    this.publishRecord(next);
    return next;
  }

  private replaceRecord(updated: LogRecord): void {
    this.ring.replace(updated.seq, updated);
    this.publishRecord(updated);
  }

  // A candidate stays while a record at most a window from it may still
  // commit: the one committing now, a fold still open, a stream still queued
  // or refused, or output on its way in. While readers are held back, only
  // the window's caps apply.
  private expireCorrelate(committingAtMs: number): void {
    if (this.readersHeld()) {
      return;
    }
    let mark = Math.min(Date.now() - IN_FLIGHT_SLACK_MS, committingAtMs);
    const held = this.assembler.oldestFirstAt();
    if (held !== undefined && held < mark) {
      mark = held;
    }
    const behind = this.pipeline?.lowWatermark();
    if (behind !== undefined && behind < mark) {
      mark = behind;
    }
    this.hopWindow.expire(mark);
  }

  private pushRing(event: LogRecord): void {
    this.ring.push(event);
  }

  private publishRecord(event: LogRecord): void {
    this.bus?.publish(newEvent(LogReceived, event.service, { event, level: event.severityText }));
    this.noteBatch(event);
    this.onRecord?.(event);
    if (!this.writer) {
      return;
    }
    const text = `${JSON.stringify(event)}\n`;
    const key = safeServiceFile(event.service);
    this.writer.write(key, text);
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

  // What a query sees: every open fold except one whose stream may still
  // deliver older lines, which would otherwise split it at an arbitrary point.
  private flushPending(): void {
    for (const folded of this.assembler.flushAll(this.foldBusy)) {
      this.commitFolded(folded);
    }
    this.scheduleIdleFlush();
  }

  private commitAllFolds(): void {
    for (const folded of this.assembler.flushAll()) {
      this.commitFolded(folded);
    }
    this.clearIdleTimer();
  }

  private flushIdleFolds(nowMs: number): void {
    for (const folded of this.assembler.flushIdle(nowMs, this.foldBusy)) {
      this.commitFolded(folded);
    }
  }

  // The wall clock closes the fold of a stream that has gone quiet. A stream
  // that may still deliver older lines (queued, refused, being replayed, or
  // held back by a paused pipeline) is not quiet: its fold closes by event
  // time as those lines arrive.
  private readonly foldBusy = (first: LogIngest): boolean => {
    if (this.readersHeld()) {
      return true;
    }
    const key = { service: first.service, stream: first.stream ?? first.source, pid: first.pid };
    return this.replaying.has(foldStreamKey(key)) || this.pipeline?.streamBusy(key) === true;
  };

  // Some reader may be holding output it read earlier: a full pipeline, or a full sender upstream.
  private readersHeld(): boolean {
    return this.upstreamPaused || this.pipeline?.paused === true;
  }

  private scheduleIdleFlush(): void {
    const deadline = this.assembler.nextDeadlineMs();
    if (deadline === undefined) {
      this.clearIdleTimer();
      return;
    }
    const now = Date.now();
    // A fold already due is waiting on its stream's older output: look again shortly.
    const at = deadline > now ? deadline : now + FOLD_BUSY_RECHECK_MS;
    if (this.idleTimer !== undefined && this.idleTimerAt <= at) {
      return;
    }
    this.clearIdleTimer();
    this.idleTimerAt = at;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.flushIdleFolds(Date.now());
      this.scheduleIdleFlush();
    }, at - now);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private ensurePipeline(): IngestPipeline {
    if (this.pipeline) {
      return this.pipeline;
    }
    this.pipeline = new IngestPipeline(
      this.pipelineRoot(),
      {
        ...this.pipelineLimits,
        ...(this.maxSpoolBytes > 0 ? { spoolMaxBytes: this.maxSpoolBytes } : {}),
      },
      // A spool read or write settled: what it made ready is processed on the next slice.
      () => this.scheduleDrain(),
    );
    return this.pipeline;
  }

  private pipelineRoot(): string {
    return this.spoolDir !== "" ? this.spoolDir : join(this.persistDir !== "" ? this.persistDir : this.logRoot, `pipeline-${this.sessionID}`);
  }

  private scheduleDrain(): void {
    // While closing, drainForClose decides what is processed and what stays spooled.
    if (this.drainTimer !== undefined || this.closing) {
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drainPipeline();
    }, PROCESS_SLICE_MS);
    this.drainTimer.unref?.();
  }

  private drainPipeline(): void {
    const pipeline = this.pipeline;
    if (pipeline === undefined) {
      return;
    }
    // While writes lag, output waits in the ordered spool instead of piling
    // up in the writer, so the persisted session stays gap-free.
    if (this.writer?.backpressured() === true) {
      if (pipeline.pending()) {
        this.scheduleDrain();
      }
      return;
    }
    const more = pipeline.processSlice(this.appendLine);
    if (more) {
      this.scheduleDrain();
    }
  }

  private readonly appendLine = (line: PipelineLine): void => {
    this.append(outputLineIngest(line), line.readAtMs);
  };

  private noteBatch(event: LogRecord): void {
    if (this.bus === undefined) {
      return;
    }
    if (this.batcher === undefined) {
      this.batcher = new LogBatcher(this.sessionID, () => this.snapshot(), (payload) => {
        const service = payload.newest[0]?.service ?? event.service;
        this.bus?.publish(newEvent(LogBatch, service, payload));
      });
    }
    this.batcher.push(event);
  }

  // The ring, and below its oldest record the part of the logical window
  // (the last `max` seqs) that only the session files still hold, read within
  // one query's budget.
  private windowSource(ring: SeqSource, filter: LogFilter, matches: LogMatcher): SeqSource {
    const oldest = this.ring.oldestSeq();
    const windowStart = Math.max(1, this.nextSeq - this.max);
    if (this.evicted === undefined || oldest === undefined || oldest <= windowStart) {
      return ring;
    }
    const budget = readBudget(this.scanBytes, this.scanMs);
    return stackedSource(ring, oldest, this.evicted.source({ matches, services: filter.services, key: matchCacheKey(filter) }, windowStart, oldest, budget));
  }

  /** Bytes read back from this session's files for queries so far. */
  evictedBytesRead(): number {
    return this.evicted?.bytesRead ?? 0;
  }

  private writeManifest(closed: boolean): void {
    if (!this.persist) {
      return;
    }
    this.owner ??= { pid: process.pid, ...readSelfStamp() };
    const body = {
      repo: this.repoKey,
      retentionDays: this.retentionDays,
      bytes: this.writer?.sessionByteCount() ?? 0,
      owner: this.owner,
      closedAt: closed ? new Date().toISOString() : undefined,
    };
    writeFileSync(join(this.persistDir, "manifest.json"), `${JSON.stringify(body)}\n`, { mode: 0o600 });
  }
}

// A line of service output, stamped with the time it was read from the pipe.
function outputLineIngest(line: PipelineLine): LogIngest {
  return {
    timestamp: new Date(line.readAtMs).toISOString(),
    service: line.service,
    source: line.stream,
    stream: line.stream,
    level: "",
    message: line.line,
    pid: line.pid,
  };
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

export function inProcessLogStore(mgr: LogManager): LogStore {
  return {
    append: (event) => {
      mgr.append(event);
    },
    query: async (filter) => mgr.query(filter),
    queryPage: async (filter, page) => mgr.queryPage(filter, page),
    historyPage: async (session, filter, page) => mgr.historyPage(session, filter, page),
    queryFacets: async (filter) => mgr.queryFacets(filter),
    snapshot: () => mgr.snapshot(),
    exportTo: async (path, filter) => {
      mgr.exportTo(path, filter);
    },
    setParsers: (parsers) => {
      mgr.setParsers(parsers);
    },
    setServiceLogs: (logs) => {
      mgr.setServiceLogs(logs);
    },
    setSecrets: (_extraMarkers, _extraPatterns, _redact) => {
      // The supervisor updates the same Detector instance this manager holds.
    },
    close: () => mgr.close(),
    ingestChunk: (chunk) => mgr.acceptChunk(chunk),
    ingestPaused: () => mgr.ingestPaused(),
    flush: () => mgr.flush(),
    setMemoryBudget: (bytes) => {
      mgr.setMemoryBudget(bytes);
    },
    pipelineStats: () => mgr.pipelineStats(),
  };
}
