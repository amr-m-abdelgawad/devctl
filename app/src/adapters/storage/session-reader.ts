import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LogMatcher } from "../../domain/logs/filter.ts";
import type { LogRecord } from "../../domain/logs/logs.ts";
import type { SeqSource, Walk } from "./log-page.ts";
import { firstAtOrAbove, MatchCache, type LineLocation, type ScannedRange } from "./match-cache.ts";
import { parseStoredLogRecord, partIndexFile, partPatchFile, safeServiceFile } from "./session-files.ts";

const KIB = 1024;
// A checkpoint every 64 KiB of a part that has been read.
const CHECKPOINT_BYTES = 64 * KIB;
// Probes bisect the stretch before a start point until reading it costs about this much.
const REFINE_BYTES = 256 * KIB;
const PROBE_BYTES = 16 * KIB;
const PROBE_MAX_BYTES = 4 * 1024 * KIB;
const PROBE_LINES = 8;
// Reads start small and double, so a short page reads little and a long scan few times.
const READ_BYTES = 64 * KIB;
const READ_MAX_BYTES = 1024 * KIB;
// Past the first line at or above a range's end, a copy of a replaced record
// can still follow: it is appended again, with its old seq, a moment later.
const SLACK_BYTES = 64 * KIB;
// A walk reads spans of seqs sized to what its caller still wants.
const MIN_SPAN = 16;
const FIRST_SPAN = 256;
const MAX_SPAN = 16_384;
const NEWLINE = 0x0a;
const SEQ_PREFIX = Buffer.from('{"seq":');

/**
 * Bytes and time one query may spend reading session files. The clock
 * starts at the query's first read, so time spent walking the ring first
 * does not count against the files.
 */
export type ReadBudget = { bytesLeft: number; readonly ms: number; deadline?: number; progressed: boolean };

export function readBudget(bytes: number, ms: number): ReadBudget {
  return { bytesLeft: bytes, ms, progressed: false };
}

// Out of bytes, or out of time once the query has finished a span: its
// first span always finishes, so every query moves the walk on.
function spent(budget: ReadBudget): boolean {
  return budget.bytesLeft <= 0 || (budget.progressed && late(budget));
}

function late(budget: ReadBudget): boolean {
  return budget.deadline !== undefined && performance.now() > budget.deadline;
}

/** What a walk over session files keeps, and which service files it can skip. */
export type SessionQuery = {
  readonly matches: LogMatcher;
  readonly services?: readonly string[];
  /** Names the filter when its matches are few enough to cache. */
  readonly key?: string;
};

/**
 * Line starts in one append-only part file, each paired with an upper bound
 * on every seq written before it. Seqs rise through a part (a replaced
 * record is appended again later, with its old seq), so the last checkpoint
 * whose bound is below a seq is a safe place to start reading for it.
 * Checkpoints come from the index the writer keeps beside the part
 * (`<part>.idx`), when it has one. A part without one (an older devctl
 * wrote it, or a crash replay appended past what the index covers) gets
 * them from reads, one per 64 KiB, and from probes that bisect an unread
 * stretch. A read's bound is exact; a probe's is the highest seq among the
 * lines it saw, which fails only if every one of them was a replaced copy,
 * so reading starts a little before a probed checkpoint.
 */
class PartIndex {
  readonly offsets: number[] = [0];
  readonly bounds: number[] = [0];
  readonly probed: boolean[] = [false];
  // The writer's own entries, in order. Their bounds are exact, which the
  // others (raised to stay sorted, or a probe's) need not be.
  private readonly written: Array<[offset: number, bound: number]> = [];

  /** Index of the last checkpoint whose bound is below `seq`. */
  startFor(seq: number): number {
    let lo = 0;
    let hi = this.bounds.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.bounds[mid]! < seq) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return Math.max(0, lo - 1);
  }

  /** An entry of the writer's index: usable for where a range starts and where it ends. */
  addWritten(offset: number, bound: number): void {
    this.written.push([offset, bound]);
    this.add(offset, bound);
  }

  /**
   * Where the writer's index says seqs below `seq` end: the first of its
   * entries with `seq` or higher before it. Undefined past what it covers.
   */
  endFor(seq: number): number | undefined {
    let lo = 0;
    let hi = this.written.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.written[mid]![1] < seq) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return this.written[lo]?.[0];
  }

  /** False when a checkpoint already sits close by. */
  add(offset: number, bound: number, probed = false): boolean {
    let at = 0;
    let hi = this.offsets.length;
    while (at < hi) {
      const mid = (at + hi) >>> 1;
      if (this.offsets[mid]! < offset) {
        at = mid + 1;
      } else {
        hi = mid;
      }
    }
    const near = (index: number): boolean => index >= 0 && index < this.offsets.length && Math.abs(this.offsets[index]! - offset) < CHECKPOINT_BYTES / 2;
    if (near(at) || near(at - 1)) {
      return false;
    }
    // Raising a bound keeps it an upper bound, and keeps the bounds sorted.
    const kept = Math.max(bound, this.bounds[at - 1] ?? 0);
    this.offsets.splice(at, 0, offset);
    this.bounds.splice(at, 0, kept);
    this.probed.splice(at, 0, probed);
    for (let next = at + 1; next < this.bounds.length && this.bounds[next]! < kept; next += 1) {
      this.bounds[next] = kept;
    }
    return true;
  }
}

type SeqSpan = { low: number; high: number };

type PartFile = {
  readonly name: string;
  readonly key: string;
  readonly part: number;
  readonly index: PartIndex;
  // How much of the writer's index beside the part has been read, and what it
  // says: the part's first seq and, once it is sealed, its size and last seq.
  // Its checkpoints wait, as text, in `unparsed` until the part is read.
  indexBytes: number;
  unparsed: string;
  low?: number;
  sealed?: { size: number; seq: number };
  // Seqs of the first lines, read once when there is no index to say.
  head?: SeqSpan;
  // Highest seq of the last lines, for the size it was read at.
  tail?: { size: number; seq: number };
  // Records replaced after they were written, by seq, from the patch file
  // beside the part, and how much of that file has been read.
  readonly patches: Map<number, string>;
  patchBytes: number;
};

// A part as one walk sees it: its size now, and a descriptor once it is read.
type OpenPart = { file: PartFile; size: number; fd?: number };

type Line = { text: string; location: LineLocation };

// How visiting one span went: the matches it visited, the walk's end when
// it ended there, and (for a scanned span) where every match in it is.
type Step = { visited: number; end?: Walk; matches?: readonly LineLocation[] };

/**
 * Reads records of one session directory by seq range across every
 * service's part files, without reading any file whole. It keeps a sparse
 * index per part, built lazily as ranges are read. Every read counts against
 * the caller's budget and toward `bytesRead`.
 */
export class SessionReader {
  bytesRead = 0;
  /** Reads made to bisect a part that has no index for the stretch. */
  probes = 0;
  private readonly parts = new Map<string, PartFile>();
  private readonly cache = new MatchCache();
  // Bytes read per seq of range scanned, learned from earlier spans.
  private perSeq = 0;

  constructor(
    private readonly dir: string,
    private readonly exclude: ReadonlySet<string> = new Set(),
  ) {}

  /** The records with seq in [lo, hi) that `query` keeps, as a walkable source. */
  source(query: SessionQuery, lo: number, hi: number, budget: ReadBudget): SeqSource {
    return {
      walkDown: (before, visit, want) => this.walk(query, lo, Math.min(before, hi), true, visit, want, budget),
      walkUp: (from, visit, want) => this.walk(query, Math.max(from, lo), hi, false, visit, want, budget),
    };
  }

  /** The highest seq written, or 0 for an empty session. */
  lastSeq(budget: ReadBudget): number {
    return this.withParts(undefined, (open) => {
      let last = 0;
      for (const part of open) {
        last = Math.max(last, part.file.sealed?.size === part.size ? part.file.sealed.seq : this.tail(part, budget));
      }
      return last;
    });
  }

  // Walks [lo, hi) one span of seqs at a time, newest first when `down`.
  // A span inside the range this query has scanned before reads only the
  // cached matches' lines; what the walk scans is folded into that range.
  private walk(query: SessionQuery, lo: number, hi: number, down: boolean, visit: (event: LogRecord) => boolean, want: number | undefined, budget: ReadBudget): Walk {
    return this.withParts(query.services, (open, byName): Walk => {
      const cached = query.key === undefined ? undefined : this.cache.get(query.key, lo);
      let run: ScannedRange | undefined;
      // The edge of what has been read so far.
      let edge = down ? hi : lo;
      let covered = 0;
      let found = 0;
      let end: Walk | undefined;
      while (end === undefined && (down ? edge > lo : edge < hi)) {
        // A query already out of time reads only the smallest span, to make progress.
        const span = !budget.progressed && late(budget) ? MIN_SPAN : this.spanFor((want ?? FIRST_SPAN) - found, found, covered, budget);
        const planned = down ? [Math.max(lo, edge - span), edge] : [edge, Math.min(hi, edge + span)];
        const [bottom, top] = alignToCache(planned[0]!, planned[1]!, lo, hi, down, cached, this.affordable(budget));
        const inCache = cached !== undefined && bottom >= cached.lo && top <= cached.hi;
        const step = inCache
          ? this.visitCached(byName, cached.matches, bottom, top, down, query, visit, budget)
          : this.visitScanned(open, query, bottom, top, down, visit, budget);
        const matches = inCache ? cached.matches.slice(firstAtOrAbove(cached.matches, bottom), firstAtOrAbove(cached.matches, top)) : step.matches;
        if (matches !== undefined) {
          run = extendRun(run, bottom, top, matches, down);
        }
        found += step.visited;
        covered += top - bottom;
        edge = down ? bottom : top;
        end = step.end;
        // Only new ground counts: a query that has read only cached matches has not moved the walk on.
        budget.progressed ||= !inCache && (end === undefined || !end.truncated);
      }
      if (query.key !== undefined && run !== undefined) {
        this.cache.remember(query.key, run);
      }
      return end ?? { truncated: false, frontier: down ? lo : hi - 1 };
    });
  }

  private visitScanned(open: readonly OpenPart[], query: SessionQuery, bottom: number, top: number, down: boolean, visit: (event: LogRecord) => boolean, budget: ReadBudget): Step {
    const before = this.bytesRead;
    const scanned = spent(budget) ? undefined : this.readRange(open, query, bottom, top, budget);
    this.learn(top - bottom, scanned?.lineBytes, this.bytesRead - before);
    if (scanned === undefined) {
      return { visited: 0, end: { truncated: true, frontier: down ? top : bottom - 1 } };
    }
    let visited = 0;
    for (const event of down ? [...scanned.records].reverse() : scanned.records) {
      visited += 1;
      if (!visit(event)) {
        return { visited, end: { truncated: false, frontier: event.seq }, matches: scanned.matches };
      }
    }
    return { visited, matches: scanned.matches };
  }

  // Reads each cached match's line where the cache says it is.
  private visitCached(byName: ReadonlyMap<string, OpenPart>, matches: readonly LineLocation[], bottom: number, top: number, down: boolean, query: SessionQuery, visit: (event: LogRecord) => boolean, budget: ReadBudget): Step {
    const from = firstAtOrAbove(matches, bottom);
    const to = firstAtOrAbove(matches, top);
    let visited = 0;
    for (let at = down ? to - 1 : from; down ? at >= from : at < to; at += down ? -1 : 1) {
      const location = matches[at]!;
      if (spent(budget)) {
        return { visited, end: { truncated: true, frontier: down ? location.seq + 1 : location.seq - 1 } };
      }
      const part = byName.get(location.part);
      const patched = part?.file.patches.get(location.seq);
      const text = patched ?? (part === undefined || location.length === 0 ? undefined : this.read(part, location.offset, location.length, budget).toString("utf8"));
      const record = text === undefined ? undefined : parseStoredLogRecord(text);
      if (record?.seq === location.seq && query.matches(record)) {
        visited += 1;
        if (!visit(record)) {
          return { visited, end: { truncated: false, frontier: record.seq } };
        }
      }
    }
    return { visited };
  }

  // Seqs a span may cover for half the budget left, at the bytes a seq's lines have taken.
  private affordable(budget: ReadBudget): number {
    return this.perSeq > 0 ? Math.floor(budget.bytesLeft / 2 / this.perSeq) : MAX_SPAN;
  }

  // Seqs the next span covers: enough to hold what is still wanted at the
  // match rate seen so far (every seq matching until a span says otherwise),
  // and no more than the budget left affords.
  private spanFor(wanted: number, found: number, covered: number, budget: ReadBudget): number {
    const likely = covered === 0 ? Math.max(1, wanted) : found === 0 ? covered * 2 : Math.ceil((Math.max(1, wanted) * covered * 1.25) / found);
    return Math.max(MIN_SPAN, Math.min(MAX_SPAN, likely, this.affordable(budget)));
  }

  // Learns what a seq's lines take from a scanned span, leaving out the
  // seek and look-ahead each span pays once. A first span the budget cut
  // short, with nothing learned yet, is taken to need twice what it read.
  private learn(covered: number, lineBytes: number | undefined, readBytes: number): void {
    if (covered <= 0) {
      return;
    }
    if (lineBytes !== undefined && lineBytes > 0) {
      const observed = lineBytes / covered;
      this.perSeq = this.perSeq <= 0 ? observed : (this.perSeq + observed) / 2;
    } else if (lineBytes === undefined && this.perSeq <= 0 && readBytes > 0) {
      this.perSeq = (2 * readBytes) / covered;
    }
  }

  // Records with seq in [bottom, top) that the query keeps, in seq order,
  // with where each one's line is and how many bytes the range's lines took,
  // or undefined when the budget ran out partway.
  private readRange(open: readonly OpenPart[], query: SessionQuery, bottom: number, top: number, budget: ReadBudget): { records: LogRecord[]; matches: LineLocation[]; lineBytes: number } | undefined {
    const lines = new Map<number, Line>();
    for (let index = 0; index < open.length; index += 1) {
      const part = open[index]!;
      const extent = this.extent(part, budget);
      const overlaps = extent !== undefined && extent.low < top && extent.high >= bottom;
      if (overlaps && !this.scanPart(part, bottom, top, lines, budget)) {
        return undefined;
      }
      if (overlaps) {
        overlayPatches(part.file, bottom, top, lines);
      }
    }
    const kept: Array<{ record: LogRecord; location: LineLocation }> = [];
    let lineBytes = 0;
    for (const line of lines.values()) {
      lineBytes += line.location.length;
      const record = parseStoredLogRecord(line.text);
      if (record !== undefined && query.matches(record)) {
        kept.push({ record, location: line.location });
      }
    }
    kept.sort((a, b) => a.record.seq - b.record.seq);
    return { records: kept.map((row) => row.record), matches: kept.map((row) => row.location), lineBytes };
  }

  // The lowest seq a part holds and a bound on its highest, judged from the
  // part itself: a crash replay appends to a dead session's first part, so
  // the next part's start says nothing. A sealed, indexed part gives both
  // without a read; one still growing may hold anything above its start.
  private extent(part: OpenPart, budget: ReadBudget): SeqSpan | undefined {
    const file = part.file;
    if (file.low !== undefined) {
      return { low: file.low, high: file.sealed?.size === part.size ? file.sealed.seq : Number.POSITIVE_INFINITY };
    }
    const head = this.head(part, budget);
    const high = head === undefined ? 0 : this.tail(part, budget);
    return head === undefined ? undefined : { low: head.low, high: high > 0 ? high : Number.POSITIVE_INFINITY };
  }

  // Collects the part's lines with seq in [bottom, top). A later copy of a
  // seq replaces an earlier one. False when the budget ran out.
  private scanPart(part: OpenPart, bottom: number, top: number, lines: Map<number, Line>, budget: ReadBudget): boolean {
    const index = part.file.index;
    for (const row of part.file.unparsed.split("\n")) {
      const [offset, bound] = indexEntry(row);
      if (Number.isInteger(offset) && Number.isInteger(bound)) {
        index.addWritten(offset, bound);
      }
    }
    part.file.unparsed = "";
    const start = this.refine(part, bottom, budget);
    let position = index.offsets[start]!;
    let bound = index.bounds[start]!;
    // Back up a little from a probed start and drop the partial line there.
    let midLine = false;
    if (index.probed[start] === true) {
      const previous = index.offsets[start - 1] ?? 0;
      midLine = position - SLACK_BYTES > previous;
      position = midLine ? position - SLACK_BYTES : previous;
    }
    let checkpointAt = position;
    // An indexed part holds each seq once, in order, so its index says where
    // the range ends. Any other part is read until a line reaches the range's
    // end, and a little past it for a late copy of a replaced record.
    const indexed = part.file.low !== undefined;
    const limit = indexed ? Math.min(part.size, index.endFor(top) ?? part.size) : part.size;
    let stopAt = limit;
    let chunk = READ_BYTES;
    while (position < stopAt) {
      if (spent(budget)) {
        return false;
      }
      const buf = this.read(part, position, Math.min(chunk, limit - position), budget);
      let lineStart = midLine ? buf.indexOf(NEWLINE) + 1 : 0;
      let newline = lineStart === 0 && midLine ? -1 : buf.indexOf(NEWLINE, lineStart);
      if (newline < 0) {
        if (position + buf.length >= limit) {
          // The line still being written.
          return true;
        }
        chunk *= 2;
        continue;
      }
      chunk = Math.min(READ_MAX_BYTES, Math.max(READ_BYTES, chunk * 2));
      while (newline >= 0) {
        const offset = position + lineStart;
        if (offset - checkpointAt >= CHECKPOINT_BYTES) {
          index.add(offset, bound);
          checkpointAt = offset;
        }
        const seq = lineSeq(buf, lineStart, newline);
        if (seq !== undefined) {
          if (seq >= bottom && seq < top) {
            lines.set(seq, { text: buf.toString("utf8", lineStart, newline), location: { seq, part: part.file.name, offset, length: newline - lineStart } });
          } else if (seq >= top && stopAt === limit) {
            stopAt = Math.min(limit, offset + (indexed ? 0 : SLACK_BYTES));
          }
          bound = Math.max(bound, seq);
        }
        lineStart = newline + 1;
        newline = buf.indexOf(NEWLINE, lineStart);
      }
      position += lineStart;
      midLine = false;
    }
    return true;
  }

  // The checkpoint to start reading at for `seq`, once probes have bisected
  // any long unread stretch in front of it.
  private refine(part: OpenPart, seq: number, budget: ReadBudget): number {
    const index = part.file.index;
    for (;;) {
      const start = index.startFor(seq);
      const from = index.offsets[start]!;
      const to = index.offsets[start + 1] ?? part.size;
      if (to - from <= REFINE_BYTES || spent(budget)) {
        return start;
      }
      this.probes += 1;
      const probe = this.probe(part, from + Math.floor((to - from) / 2), budget);
      if (probe === undefined || probe.offset <= from || probe.offset >= to || !index.add(probe.offset, probe.seqs.high, true)) {
        return start;
      }
    }
  }

  // The first whole lines at or after `at`: where the first one starts, and
  // the lowest and highest seq among them. The highest is above every seq
  // written before them, as some line among them is an original.
  private probe(part: OpenPart, at: number, budget: ReadBudget): { offset: number; seqs: SeqSpan } | undefined {
    for (let length = PROBE_BYTES; length <= PROBE_MAX_BYTES; length *= 2) {
      const buf = this.read(part, at, Math.min(length, part.size - at), budget);
      const first = at === 0 ? 0 : buf.indexOf(NEWLINE) + 1;
      const seqs = first === 0 && at !== 0 ? undefined : seqsOfLines(buf, first, PROBE_LINES);
      if (seqs !== undefined) {
        return { offset: at + first, seqs };
      }
      if (at + buf.length >= part.size) {
        return undefined;
      }
    }
    return undefined;
  }

  private head(part: OpenPart, budget: ReadBudget): SeqSpan | undefined {
    if (part.file.head === undefined && part.size > 0) {
      part.file.head = this.probe(part, 0, budget)?.seqs;
    }
    return part.file.head;
  }

  // The highest seq among a part's last whole lines.
  private tail(part: OpenPart, budget: ReadBudget): number {
    if (part.file.tail?.size === part.size) {
      return part.file.tail.seq;
    }
    let seq = 0;
    for (let length = PROBE_BYTES; length <= PROBE_MAX_BYTES; length *= 2) {
      const from = Math.max(0, part.size - length);
      const buf = this.read(part, from, part.size - from, budget);
      const first = from === 0 ? 0 : buf.indexOf(NEWLINE) + 1;
      const seqs = first === 0 && from !== 0 ? undefined : seqsOfLines(buf, first, Number.POSITIVE_INFINITY);
      if (seqs !== undefined || from === 0) {
        seq = seqs?.high ?? 0;
        break;
      }
    }
    part.file.tail = { size: part.size, seq };
    return seq;
  }

  private read(part: OpenPart, position: number, length: number, budget: ReadBudget): Buffer {
    budget.deadline ??= performance.now() + budget.ms;
    part.fd ??= openQuiet(join(this.dir, part.file.name));
    const buf = Buffer.alloc(part.fd === undefined ? 0 : Math.max(0, length));
    const got = part.fd !== undefined && buf.length > 0 ? readSync(part.fd, buf, 0, buf.length, position) : 0;
    this.bytesRead += got;
    budget.bytesLeft -= got;
    return got === buf.length ? buf : buf.subarray(0, got);
  }

  // The session's part files (only those of `services`, when given), ordered
  // by service and part, for the length of one walk. A part is opened when
  // it is first read, and its sidecars are looked at only when the listing
  // shows them and they can have grown.
  private withParts<T>(services: readonly string[] | undefined, walk: (open: OpenPart[], byName: ReadonlyMap<string, OpenPart>) => T): T {
    const keys = services !== undefined && services.length > 0 ? new Set(services.map(safeServiceFile)) : undefined;
    const listed = new Set(listFiles(this.dir));
    for (const name of this.parts.keys()) {
      if (!listed.has(name)) {
        this.parts.delete(name);
      }
    }
    const open: OpenPart[] = [];
    try {
      for (const name of listed) {
        const file = !name.endsWith(".jsonl") || this.exclude.has(name) ? undefined : this.partFile(name);
        const size = file === undefined || (keys !== undefined && !keys.has(file.key)) ? undefined : sizeQuiet(join(this.dir, name));
        if (file !== undefined && size !== undefined) {
          open.push({ file, size });
          if (file.sealed?.size !== size && listed.has(partIndexFile(name))) {
            this.loadIndex(file, size);
          }
          if (listed.has(partPatchFile(name))) {
            this.loadPatches(file);
          }
        }
      }
      open.sort((a, b) => (a.file.key === b.file.key ? a.file.part - b.file.part : a.file.key < b.file.key ? -1 : 1));
      return walk(open, new Map(open.map((part) => [part.file.name, part])));
    } finally {
      for (const part of open) {
        if (part.fd !== undefined) {
          closeSync(part.fd);
        }
      }
    }
  }

  // Reads what the writer has appended to the part's index since last time:
  // lines of `offset bound`. Only the ends are looked at here: the first line
  // gives the part's first seq, and a sealed part's last gives its size and
  // last seq. The checkpoints between stay text until the part is read. An
  // entry past the part's size was written ahead of its lines and waits.
  private loadIndex(file: PartFile, size: number): void {
    let text = this.appended(partIndexFile(file.name), file.indexBytes).toString("latin1");
    let last = lastIndexEntry(text);
    while (text !== "" && !(last.entry[0] <= size)) {
      text = text.slice(0, last.start);
      last = lastIndexEntry(text);
    }
    const firstEnd = text.indexOf("\n");
    const first = indexEntry(text.slice(0, Math.max(0, firstEnd)));
    if (text === "" || (file.low === undefined && first[0] !== 0)) {
      return;
    }
    file.indexBytes += text.length;
    file.sealed = last.entry[0] === size ? { size, seq: last.entry[1] } : file.sealed;
    if (first[0] === 0) {
      file.low = first[1] + 1;
      file.index.bounds[0] = Math.max(file.index.bounds[0]!, first[1]);
    }
    file.unparsed += first[0] === 0 ? text.slice(firstEnd + 1) : text;
  }

  // Reads what has been appended to the part's patch file since last time.
  // A patch can change which filters keep its record, so cached ranges that
  // hold a patched seq are forgotten.
  private loadPatches(file: PartFile): void {
    const buf = this.appended(partPatchFile(file.name), file.patchBytes);
    let low = Number.POSITIVE_INFINITY;
    let high = 0;
    for (let lineStart = 0; lineStart < buf.length; ) {
      const newline = buf.indexOf(NEWLINE, lineStart);
      const seq = lineSeq(buf, lineStart, newline);
      if (seq !== undefined) {
        file.patches.set(seq, buf.toString("utf8", lineStart, newline));
        low = Math.min(low, seq);
        high = Math.max(high, seq);
      }
      lineStart = newline + 1;
    }
    file.patchBytes += buf.length;
    if (high > 0) {
      this.cache.invalidate(low, high);
    }
  }

  // The whole lines appended to a sidecar since `from` bytes of it were read.
  private appended(name: string, from: number): Buffer {
    const path = join(this.dir, name);
    const size = sizeQuiet(path) ?? 0;
    const fd = size > from ? openQuiet(path) : undefined;
    if (fd === undefined) {
      return Buffer.alloc(0);
    }
    try {
      const buf = Buffer.alloc(size - from);
      const got = readSync(fd, buf, 0, buf.length, from);
      this.bytesRead += got;
      return buf.subarray(0, buf.lastIndexOf(NEWLINE, got - 1) + 1);
    } finally {
      closeSync(fd);
    }
  }

  private partFile(name: string): PartFile | undefined {
    const known = this.parts.get(name);
    if (known !== undefined) {
      return known;
    }
    const stem = name.slice(0, -".jsonl".length);
    const tilde = stem.lastIndexOf("~");
    const part = tilde < 0 ? 0 : Number(stem.slice(tilde + 1));
    if (!Number.isInteger(part) || part < 0) {
      return undefined;
    }
    const file: PartFile = { name, key: tilde < 0 ? stem : stem.slice(0, tilde), part, index: new PartIndex(), indexBytes: 0, unparsed: "", patches: new Map(), patchBytes: 0 };
    this.parts.set(name, file);
    return file;
  }
}

// One line of a part's index: an offset and the highest seq before it.
function indexEntry(row: string): [number, number] {
  const space = row.indexOf(" ");
  return space < 0 ? [Number.NaN, Number.NaN] : [Number(row.slice(0, space)), Number(row.slice(space + 1))];
}

// The last line of index text that ends in a newline, and where it starts.
function lastIndexEntry(text: string): { start: number; entry: [number, number] } {
  const start = text.lastIndexOf("\n", text.length - 2) + 1;
  return { start, entry: indexEntry(text.slice(start, -1)) };
}

// Lays the part's patches over the lines read for [bottom, top). A patch is a
// whole record and stands on its own, so one whose line was never written
// (the disk was full then) still shows.
function overlayPatches(file: PartFile, bottom: number, top: number, lines: Map<number, Line>): void {
  for (const [seq, text] of file.patches) {
    if (seq >= bottom && seq < top) {
      const base = lines.get(seq)?.location;
      lines.set(seq, { text, location: base ?? { seq, part: file.name, offset: 0, length: 0 } });
    }
  }
}

// Keeps a planned span wholly inside or wholly outside the cached range. A
// span inside it runs to the range's edge, since only its matches are read;
// one that stops just short of it is stretched to meet it when affordable.
function alignToCache(bottom: number, top: number, lo: number, hi: number, down: boolean, cached: ScannedRange | undefined, affordable: number): [number, number] {
  if (cached === undefined) {
    return [bottom, top];
  }
  const reach = Math.min(MAX_SPAN, affordable);
  if (down) {
    if (top > cached.lo && top <= cached.hi) {
      return [Math.max(lo, cached.lo), top];
    }
    if (top > cached.hi && (bottom < cached.hi || top - cached.hi <= reach)) {
      return [cached.hi, top];
    }
    return [bottom, top];
  }
  if (bottom >= cached.lo && bottom < cached.hi) {
    return [bottom, Math.min(hi, cached.hi)];
  }
  if (bottom < cached.lo && (top > cached.lo || cached.lo - bottom <= reach)) {
    return [bottom, cached.lo];
  }
  return [bottom, top];
}

function extendRun(run: ScannedRange | undefined, bottom: number, top: number, matches: readonly LineLocation[], down: boolean): ScannedRange {
  if (run === undefined) {
    return { lo: bottom, hi: top, matches };
  }
  return down ? { lo: bottom, hi: run.hi, matches: [...matches, ...run.matches] } : { lo: run.lo, hi: top, matches: [...run.matches, ...matches] };
}

// Lowest and highest seq among up to `count` whole lines from `start`.
function seqsOfLines(buf: Buffer, start: number, count: number): SeqSpan | undefined {
  let low = Number.POSITIVE_INFINITY;
  let high = 0;
  let lineStart = start;
  for (let lines = 0; lines < count; lines += 1) {
    const newline = buf.indexOf(NEWLINE, lineStart);
    if (newline < 0) {
      break;
    }
    const seq = lineSeq(buf, lineStart, newline);
    if (seq !== undefined) {
      low = Math.min(low, seq);
      high = Math.max(high, seq);
    }
    lineStart = newline + 1;
  }
  return high > 0 ? { low, high } : undefined;
}

// The seq of the stored record on one line. Records are written with seq as
// their first key, so the digits are read in place; any other line is parsed.
function lineSeq(buf: Buffer, start: number, end: number): number | undefined {
  const digits = start + SEQ_PREFIX.length;
  if (end > digits && buf.compare(SEQ_PREFIX, 0, SEQ_PREFIX.length, start, digits) === 0) {
    let seq = 0;
    let at = digits;
    while (at < end && buf[at]! >= 0x30 && buf[at]! <= 0x39) {
      seq = seq * 10 + (buf[at]! - 0x30);
      at += 1;
    }
    if (at > digits && (buf[at] === 0x2c || buf[at] === 0x7d)) {
      return seq;
    }
  }
  return parseStoredLogRecord(buf.toString("utf8", start, end))?.seq;
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Undefined for a file removed since the listing (the writer's session cap evicts parts).
function sizeQuiet(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function openQuiet(path: string): number | undefined {
  try {
    return openSync(path, "r");
  } catch {
    return undefined;
  }
}
